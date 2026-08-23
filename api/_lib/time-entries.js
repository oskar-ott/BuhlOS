// Shared helpers for the new time-entry workflow (per-user multi-allocation,
// status: draft → submitted → approved/rejected). See api/time-entries.js for
// HTTP routes and scripts/migrate-hours.js for legacy import.
//
// Storage:
//   users/<userId>/time-entries/<date>.json    → one entry per user per day
//   users/<userId>/time-entries-audit/<yyyy-mm>.json → append-only audit log

const { put, list, del } = require('@vercel/blob');
const { readBlob, writeBlob, deleteBlob } = require('./blob');
const { mirrorTimeEntry, mirrorTimeEntryDelete } = require('./hours-mirror');
const { recordMirrorDrift } = require('./mirror-drift'); // DWD-04: surface Blob-ok/PG-fail drift
const { listUserEntriesFromPgIfEnabled } = require('./hours-read');
const { listTimeEntryBlobs } = require('./time-entry-blobs'); // #935 paginated users/ walk

const ENTRY_PREFIX = (userId) => `users/${userId}/time-entries/`;
const ENTRY_PATH   = (userId, date) => `users/${userId}/time-entries/${date}.json`;
const AUDIT_PATH   = (userId, yyyymm) => `users/${userId}/time-entries-audit/${yyyymm}.json`;

const VALID_STATUSES = ['draft', 'submitted', 'approved', 'rejected'];

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function ymOf(date) {
  return date.slice(0, 7); // "2026-05-04" -> "2026-05"
}

// Overtime starts after the STANDARD DAY (7.6h = 7h 36m), not after 8h —
// owner-directed 2026-08-09. The field flow logs overtime as "standard day
// + 1h OT"; with the old 8h boundary that day was stored and paid as
// 8h ordinary + 36m OT, so the app's "+1h OT" and the payslip disagreed.
// One boundary, everywhere: what the worker taps is what pay classifies.
// Mirrors src/domains/timesheets/service.ts autoSplitOT EXACTLY.
const STANDARD_DAY_HOURS = 7.6;

// Sat/Sun off the calendar-date string — UTC arithmetic, timezone-free.
// Mirrors src/domains/timesheets/service.ts isWeekendDate EXACTLY.
function isWeekendDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return false;
  const day = new Date(date + 'T00:00:00Z').getUTCDay();
  return day === 0 || day === 6;
}

// Owner-directed 2026-08-10: hours beyond 38/week are overtime. The app week
// is Mon–Sun and weekday ordinary caps at the standard day (5 × 7.6h = 38h),
// so the whole weekly rule reduces to: weekend hours are ALWAYS overtime.
function autoSplitOT(totalHours, date) {
  if (date && isWeekendDate(date)) {
    return { ordinary: 0, overtime: Math.round(totalHours * 100) / 100 };
  }
  const ordinary = Math.min(totalHours, STANDARD_DAY_HOURS);
  const overtime = Math.max(0, totalHours - STANDARD_DAY_HOURS);
  return {
    ordinary: Math.round(ordinary * 100) / 100,
    overtime: Math.round(overtime * 100) / 100,
  };
}

// Server-authoritative weekend coercion: whatever split the client sent, a
// Sat/Sun entry books as ALL overtime (the client mirrors this, but the wire
// is not trusted for pay classification). Weekday entries pass through.
function enforceWeekendSplit(entry) {
  if (!entry || !isWeekendDate(entry.date)) return entry;
  // Day-type days (TAFE / sick / holiday — 2026-08-10) are never weekend
  // overtime: training and leave pay ordinary regardless of the calendar.
  if (entry.dayType) return entry;
  const total = Number(entry.totalHours) || 0;
  return {
    ...entry,
    ordinaryHours: 0,
    overtimeHours: Math.round(total * 100) / 100,
  };
}

function calcTotalHours(startTime, endTime, breakMinutes) {
  if (!startTime || !endTime) return 0;
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  const mins = (eh * 60 + em) - (sh * 60 + sm) - (breakMinutes || 0);
  return Math.max(0, Math.round((mins / 60) * 100) / 100);
}

// Maximum decimal hours allowed in a single time entry. Mirrors the
// Phase B client schema in src/domains/timesheets/schema.ts. Without
// this cap, direct-API submissions (curl, future bugs in the new
// client, the legacy my-day.html form) could submit arbitrary totals
// like 80h, which the Phase B production smoke test surfaced.
const MAX_TOTAL_HOURS_PER_DAY = 16;

// Returns array of error messages; empty array means valid.
//
// `options.skipDateWindow` drops ONLY the backdating window checks (the last
// block below). It exists for the office amend path (time-entries-amend-approve):
// an entry that already exists at its date is not being LOGGED again — the date
// is untouched — so "cannot log more than 14 days in the past" would block a
// legitimate correction of an old timesheet instead of protecting anything.
// Every payroll-relevant rule (totals, OT split, allocation sum) still applies.
function validateEntryShape(body, options = {}) {
  const errors = [];
  if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) errors.push('date required (YYYY-MM-DD)');
  if (typeof body.totalHours !== 'number' || body.totalHours <= 0) errors.push('totalHours must be > 0');
  if (typeof body.totalHours === 'number' && body.totalHours > MAX_TOTAL_HOURS_PER_DAY) {
    errors.push(`totalHours must be ≤ ${MAX_TOTAL_HOURS_PER_DAY}`);
  }
  if (typeof body.ordinaryHours !== 'number' || body.ordinaryHours < 0) errors.push('ordinaryHours invalid');
  if (typeof body.overtimeHours !== 'number' || body.overtimeHours < 0) errors.push('overtimeHours invalid');
  if (typeof body.totalHours === 'number' &&
      Math.abs((body.ordinaryHours + body.overtimeHours) - body.totalHours) > 0.01) {
    errors.push('ordinaryHours + overtimeHours must equal totalHours');
  }
  if (!Array.isArray(body.allocations) || body.allocations.length === 0) {
    errors.push('at least one allocation required');
  } else {
    const sum = body.allocations.reduce((s, a) => s + (Number(a.hours) || 0), 0);
    if (typeof body.totalHours === 'number' && Math.abs(sum - body.totalHours) > 0.01) {
      errors.push('allocation hours must sum to totalHours');
    }
    body.allocations.forEach((a, i) => {
      if (typeof a.hours !== 'number' || a.hours <= 0) errors.push(`allocation[${i}].hours must be > 0`);
    });
  }
  if (body.status && !VALID_STATUSES.includes(body.status)) errors.push('invalid status');

  // Backdating limits: tradies log up to 14 days back, no future dates.
  if (!options.skipDateWindow && body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    const entryDate = new Date(body.date + 'T00:00:00');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diffDays = (today - entryDate) / (1000 * 60 * 60 * 24);
    if (diffDays > 14) errors.push('cannot log more than 14 days in the past');
    if (diffDays < -1) errors.push('cannot log future dates');
  }

  return errors;
}

/**
 * Job-attribution check shared by every write path that must not point hours at
 * a job that isn't real and active. Returns an error message when any non-null
 * allocation jobId is missing from jobs.json or sits in a non-active state
 * (draft / archived), else null.
 *
 * A null jobId PASSES here (legacy + overhead entries predate attribution) —
 * callers that must forbid a null job say so themselves, as the field self-edit
 * path in api/time-entries.js does.
 *
 * One implementation, two callers: api/time-entries.js's field create/edit gate
 * and api/time-entries-amend-approve.js. Never a second copy of the rule.
 */
async function inactiveJobAllocationError(allocations) {
  const allocJobIds = [...new Set(
    (allocations || []).map((a) => a && a.jobId).filter(Boolean)
  )];
  if (!allocJobIds.length) return null;
  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const jobById = {};
  (jobsBlob.jobs || []).forEach((j) => { jobById[j.id] = j; });
  for (const jid of allocJobIds) {
    const job = jobById[jid];
    const active = job && job.status !== 'archived' && job.status !== 'draft';
    if (!active) return 'forbidden — hours can only be logged against an active job';
  }
  return null;
}

// Read one entry by user+date. Returns null if missing.
async function readEntry(userId, date) {
  return await readBlob(ENTRY_PATH(userId, date), null);
}

// Write one entry by user+date. Overwrites. #157: when the entry object
// came from readEntry it carries __rev — threading it as expectedRev turns
// every read-modify-write on a day-file into a guarded write (a concurrent
// approve/edit of the SAME day throws StaleWriteError instead of silently
// losing one writer). Fresh creates carry no __rev → unguarded create.
async function writeEntry(userId, entry) {
  await writeBlob(ENTRY_PATH(userId, entry.date), entry, {
    expectedRev: entry.__rev,
  });
  // #152 dual-write: best-effort mirror into Postgres. Blob is authoritative;
  // mirrorTimeEntry never throws (triple-gated, inert in prod) so a mirror
  // failure can never break the hours save.
  const mirror = await mirrorTimeEntry(userId, entry);
  // DWD-04: Blob just succeeded — if the PG mirror errored (not a gated/unmirrored
  // skip), record the divergence to the error journal so it surfaces on the owner
  // console rather than lurking until the daily sync-check. Best-effort.
  await recordMirrorDrift({ domain: 'hours', result: mirror, key: ENTRY_PATH(userId, entry.date) });
  return entry;
}

async function deleteEntry(userId, date) {
  await deleteBlob(ENTRY_PATH(userId, date));
  const mirror = await mirrorTimeEntryDelete(userId, date); // best-effort soft-delete mirror
  await recordMirrorDrift({ domain: 'hours', result: mirror, key: ENTRY_PATH(userId, date) }); // DWD-04
}

// List one user's entries (newest first), optionally filtered by date range / status.
// `deps.listPg` is injectable for tests (the PG rung is env+flag gated in prod).
async function listUserEntries(userId, { fromDate, toDate, status } = {}, deps = {}) {
  // #152 read-cutover (rung 3): serve from Postgres when supabase_read_hours is
  // on (+ env). Best-effort — {pg:false} on disabled/error falls through to Blob
  // (the source of truth). readEntry stays Blob (write path).
  const listPg = deps.listPg || listUserEntriesFromPgIfEnabled;
  const pg = await listPg(userId, { fromDate, toDate, status });
  // 2026-08-06: the PG rung gets the SAME read-your-writes overlay as the Blob
  // listing below (it used to return here without one). The PG mirror is
  // best-effort — a mirror miss on the just-logged day made that day vanish
  // from a PG-served list exactly like the listing lag did. Blob is the source
  // of truth for the freshest write, so recent day-files are re-read directly
  // and merged by updatedAt either way.
  const base = pg.pg ? pg.entries : await listUserEntriesFromBlob(userId, { fromDate, toDate });

  const byDate = new Map();
  for (const e of base) {
    if (e) byDate.set(e.date, e);
  }
  // Read-your-writes overlay (2026-07-28): recent dates are re-read through
  // readEntry — the direct-URL read dodges the listing lag, and writeBlob
  // primes that cache so a same-instance render is read-after-write
  // consistent. Bounded to a ±few-day window so absent dates cost at most a
  // handful of parallel narrow lookups.
  const overlay = await Promise.all(recentDatesWithin(fromDate, toDate).map(async d => {
    try { return await readEntry(userId, d); } catch { return null; }
  }));
  for (const e of overlay) {
    if (!e) continue;
    const listed = byDate.get(e.date);
    if (!listed || String(e.updatedAt || '') >= String(listed.updatedAt || '')) byDate.set(e.date, e);
  }

  return [...byDate.values()]
    .filter(e => !status || e.status === status)
    .sort((a, b) => b.date.localeCompare(a.date));
}

// The Blob branch of listUserEntries: list the user's day-files and fetch each.
// Blob's list() is eventually consistent — the caller overlays recent dates on
// top (see above), which also means a transient list() failure degrades to
// "recent days only" instead of a hard empty list.
async function listUserEntriesFromBlob(userId, { fromDate, toDate } = {}) {
  const prefix = ENTRY_PREFIX(userId);
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  let blobs;
  try {
    const res = await list({ prefix, token, limit: 1000 });
    blobs = res.blobs || [];
  } catch (e) {
    console.error('list error', e.message);
    return [];
  }
  const dateFiles = blobs.filter(b => b.pathname.endsWith('.json') && b.pathname.startsWith(prefix));
  const filtered = dateFiles.filter(b => {
    const d = b.pathname.slice(prefix.length, -5);
    if (fromDate && d < fromDate) return false;
    if (toDate && d > toDate) return false;
    return true;
  });
  return await Promise.all(filtered.map(async b => {
    try {
      const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }));
}

// Server-clock dates from 3 days back to tomorrow (UTC-vs-Sydney slack on both
// ends), clipped to the caller's range — the write-freshness window for the
// read-your-writes overlay above.
function recentDatesWithin(fromDate, toDate) {
  const out = [];
  const day = 24 * 60 * 60 * 1000;
  for (let offset = -3; offset <= 1; offset++) {
    const d = new Date(Date.now() + offset * day).toISOString().slice(0, 10);
    if (fromDate && d < fromDate) continue;
    if (toDate && d > toDate) continue;
    out.push(d);
  }
  return out;
}

// Walk every user's time-entries — used by /approvals queue.
// Filtered to a status (default 'submitted'). Heavier than per-user lookups
// but acceptable for the approver queue volumes.
// `status` (single) keeps the legacy default; `statuses` (array) lets a caller
// pull several states in ONE scan (e.g. per-job costing needs submitted+approved).
async function listAllEntriesForApprovers({ status = 'submitted', statuses } = {}) {
  const wanted = Array.isArray(statuses) && statuses.length ? statuses : [status];
  let entryBlobs;
  try {
    entryBlobs = await listTimeEntryBlobs(); // #935: fully paginated — never the silent 5000 cap
  } catch (e) {
    console.error('list error', e.message);
    return [];
  }
  const entries = await Promise.all(entryBlobs.map(async b => {
    try {
      const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }));
  return entries
    .filter(Boolean)
    .filter(e => wanted.includes(e.status))
    .sort((a, b) => (a.submittedAt || '').localeCompare(b.submittedAt || ''));
}

// Walk every user's time-entry blob for ONE date — the walk the daily-digest
// cron (api/notifications.js) and day-pulse inline; shared here so the #171
// office summary (and future consumers, e.g. #177) run the SAME read.
// Unlike those best-effort inlines this one COUNTS what it could not read
// (`unreadable`) so an auditable document can state its coverage gaps
// instead of presenting partial data as complete.
async function listEntriesForDate(date) {
  let blobs;
  try {
    blobs = await listTimeEntryBlobs(); // #935: fully paginated — never the silent 5000 cap
  } catch (e) {
    console.error('list error', e.message);
    return { entries: [], unreadable: -1 }; // -1 = the listing itself failed
  }
  const dayBlobs = blobs.filter((b) => b.pathname.endsWith(`/time-entries/${date}.json`));
  let unreadable = 0;
  const entries = (
    await Promise.all(
      dayBlobs.map(async (b) => {
        try {
          const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
          if (!r.ok) {
            unreadable++;
            return null;
          }
          return await r.json();
        } catch {
          unreadable++;
          return null;
        }
      })
    )
  ).filter(Boolean);
  return { entries, unreadable };
}

// Append an audit row. Best-effort — never blocks the caller's write path.
async function appendAudit(userId, entryId, action, changedBy, note, diff) {
  try {
    const yyyymm = ymOf(new Date().toISOString().slice(0, 10));
    const log = (await readBlob(AUDIT_PATH(userId, yyyymm), [])) || [];
    log.push({
      id: newId(),
      entryId,
      action,                 // 'created' | 'edited' | 'submitted' | 'approved' | 'rejected' | 'deleted'
      changedBy,
      note: note || null,
      diff: diff || null,
      at: new Date().toISOString(),
    });
    await writeBlob(AUDIT_PATH(userId, yyyymm), log);
  } catch (e) {
    console.error('audit append failed', e.message);
  }
}

// Compute the diff between two versions of an entry (for audit log).
function diffOf(before, after) {
  const fields = [
    'totalHours', 'ordinaryHours', 'overtimeHours',
    'startTime', 'endTime', 'breakMinutes',
    'notes', 'status', 'date',
  ];
  const diff = {};
  for (const f of fields) {
    if (JSON.stringify(before[f]) !== JSON.stringify(after[f])) {
      diff[f] = { from: before[f], to: after[f] };
    }
  }
  // Allocation count change → record it
  if ((before.allocations || []).length !== (after.allocations || []).length) {
    diff.allocations = { fromCount: (before.allocations||[]).length, toCount: (after.allocations||[]).length };
  }
  return Object.keys(diff).length ? diff : null;
}

// Strip the internal idempotency ring (#497) before an entry leaves the server —
// it's replay bookkeeping (doc.__idempotency), never part of the client
// contract. Returns a shallow copy; never strips __rev (the CAS revision is
// existing behaviour). Used by every handler that returns a time entry
// (create/edit/list + approve/reject) so the ring is stored but never sent.
function entryView(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const { __idempotency, ...rest } = entry;
  return rest;
}

module.exports = {
  ENTRY_PATH,
  ENTRY_PREFIX,
  AUDIT_PATH,
  VALID_STATUSES,
  newId,
  ymOf,
  autoSplitOT,
  isWeekendDate,
  enforceWeekendSplit,
  calcTotalHours,
  validateEntryShape,
  inactiveJobAllocationError,
  readEntry,
  writeEntry,
  deleteEntry,
  listUserEntries,
  listAllEntriesForApprovers,
  listEntriesForDate,
  appendAudit,
  diffOf,
  entryView,
};
