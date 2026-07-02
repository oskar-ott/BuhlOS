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
const { listUserEntriesFromPgIfEnabled } = require('./hours-read');

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

function autoSplitOT(totalHours) {
  const ordinary = Math.min(totalHours, 8);
  const overtime = Math.max(0, totalHours - 8);
  return {
    ordinary: Math.round(ordinary * 100) / 100,
    overtime: Math.round(overtime * 100) / 100,
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
function validateEntryShape(body) {
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
  if (body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    const entryDate = new Date(body.date + 'T00:00:00');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diffDays = (today - entryDate) / (1000 * 60 * 60 * 24);
    if (diffDays > 14) errors.push('cannot log more than 14 days in the past');
    if (diffDays < -1) errors.push('cannot log future dates');
  }

  return errors;
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
  await mirrorTimeEntry(userId, entry);
  return entry;
}

async function deleteEntry(userId, date) {
  await deleteBlob(ENTRY_PATH(userId, date));
  await mirrorTimeEntryDelete(userId, date); // best-effort soft-delete mirror
}

// List one user's entries (newest first), optionally filtered by date range / status.
async function listUserEntries(userId, { fromDate, toDate, status } = {}) {
  // #152 read-cutover (rung 3): serve from Postgres when supabase_read_hours is
  // on (+ env). Best-effort — {pg:false} on disabled/error falls through to Blob
  // (the source of truth). readEntry stays Blob (write path).
  const pg = await listUserEntriesFromPgIfEnabled(userId, { fromDate, toDate, status });
  if (pg.pg) return pg.entries;

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
  const entries = await Promise.all(filtered.map(async b => {
    try {
      const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }));
  return entries
    .filter(Boolean)
    .filter(e => !status || e.status === status)
    .sort((a, b) => b.date.localeCompare(a.date));
}

// Walk every user's time-entries — used by /approvals queue.
// Filtered to a status (default 'submitted'). Heavier than per-user lookups
// but acceptable for the approver queue volumes.
// `status` (single) keeps the legacy default; `statuses` (array) lets a caller
// pull several states in ONE scan (e.g. per-job costing needs submitted+approved).
async function listAllEntriesForApprovers({ status = 'submitted', statuses } = {}) {
  const wanted = Array.isArray(statuses) && statuses.length ? statuses : [status];
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  let blobs;
  try {
    const res = await list({ prefix: 'users/', token, limit: 5000 });
    blobs = res.blobs || [];
  } catch (e) {
    console.error('list error', e.message);
    return [];
  }
  const entryBlobs = blobs.filter(b =>
    b.pathname.includes('/time-entries/') &&
    !b.pathname.includes('/time-entries-audit/') &&
    b.pathname.endsWith('.json')
  );
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
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  let blobs;
  try {
    const res = await list({ prefix: 'users/', token, limit: 5000 });
    blobs = res.blobs || [];
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
  calcTotalHours,
  validateEntryShape,
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
