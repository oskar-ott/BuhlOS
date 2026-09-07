// Shared payroll-input collection (#894 seam) — the ONE row engine.
//
// EXTRACTED VERBATIM from api/time-entries-export.js so the CSV export
// (which keeps its exact behaviour — payroll-boundary ADR: the CSV is the
// permanent fallback) and the payroll-batch foundation (#893) read the SAME
// rows from the SAME collection logic. No second engine, ever: a batch can
// never pay differently than the CSV would have.
//
// Resolve the range, load reference data + every in-range entry, and build
// the one-row-per-allocation payroll rows (#380 OT proration applied BEFORE
// any jobId filter, so a filtered export never re-attributes overtime).
// Returns { ok:false, status, error } on a bad range / blob failure, else
// { ok:true, fromDate, toDate, status, userId, jobId, rows, entries,
// userById, jobById }.
//
// FRESHNESS GUARANTEE (2026-08-24 incident — wk34 print-out silently missing
// freshly-approved days): a just-overwritten day blob can serve its PREVIOUS
// content from the CDN for a short window even with cache-busting, so a stale
// read still said status='submitted' and the approved filter dropped real
// hours WITH NO ERROR. Every entry read here is now verified against the
// store's own listing metadata: list() reports each blob's last-PUT time
// (uploadedAt — API-fresh, never CDN-cached), and every mutation stamps the
// entry (updatedAt/approvedAt/…). Content whose newest stamp predates the
// last PUT by more than the skew is a stale read — retried briefly, then the
// WHOLE collection is REFUSED with a 503 naming the affected days. An
// unreadable blob is refused the same way (it used to be silently dropped).
// A payroll artifact is complete, or it does not exist — never silently
// short. Every consumer (CSV, PDF, timesheet email, Xero batch create/lock)
// flows through this one engine, so they all inherit the guarantee.

const { list } = require('@vercel/blob');
const { readBlob } = require('./blob');
const { isLeadingHandRole, isFieldRole } = require('./auth');
const { prorateAllocations } = require('./payroll-rows');

// ── Freshness-verified entry reads ───────────────────────────────────────────
// Tolerance between an entry's own write stamp and the blob's last-PUT time:
// both are Vercel wall clocks; the gap on a genuine write is the request
// latency (ms–seconds). Beyond this, the fetched content predates the PUT —
// i.e. the CDN served the pre-overwrite document.
const FRESHNESS_SKEW_MS = 15_000;
// Bounded retry before refusing (~5s worst case). Tests shrink this so the
// suite never sleeps.
let RETRY_DELAYS_MS = [500, 1000, 1500, 2000];
function __setFreshnessRetryDelaysForTests(delays) {
  RETRY_DELAYS_MS = Array.isArray(delays) ? delays : [];
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Newest server-written stamp on an entry, ms epoch — null when the entry
 *  carries none (legacy rows), in which case freshness cannot be judged and
 *  the read is accepted (never invent staleness — P7). */
function entryLastWriteMs(entry) {
  let max = 0;
  for (const k of ['updatedAt', 'approvedAt', 'rejectedAt', 'submittedAt', 'amendedAt', 'exportedAt', 'createdAt']) {
    const t = Date.parse((entry && entry[k]) || '');
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max || null;
}

/**
 * Fetch one entry blob and verify the content is at least as new as the
 * blob's last PUT. Retries per RETRY_DELAYS_MS. Resolves { entry } on a
 * verified (or unverifiable) read, else { problem: 'stale' | 'unreadable' }.
 */
async function fetchEntryVerified(b) {
  const uploadedMs = Date.parse((b && b.uploadedAt) || '');
  let lastProblem = 'unreadable';
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    let entry = null;
    try {
      const r = await fetch(b.url + '?t=' + Date.now() + '-' + attempt, { cache: 'no-store' });
      if (r.ok) entry = await r.json();
    } catch { /* fall through to retry */ }
    if (!entry) { lastProblem = 'unreadable'; continue; }
    if (!Number.isFinite(uploadedMs)) return { entry }; // no listing stamp → cannot verify
    const contentMs = entryLastWriteMs(entry);
    if (contentMs == null) return { entry }; // legacy row → cannot verify
    if (uploadedMs - contentMs <= FRESHNESS_SKEW_MS) return { entry };
    lastProblem = 'stale'; // CDN served the pre-overwrite document — retry
  }
  return { problem: lastProblem };
}

async function collectRows({ status, userId, jobId, fromDate, toDate }) {
  // Default range = current ISO week (Mon..Sun). NOTE: this is server-local
  // (UTC on Vercel); every UI caller passes explicit fromDate/toDate.
  if (!fromDate || !toDate) {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const dow = t.getDay() || 7;
    const monday = new Date(t); monday.setDate(t.getDate() - (dow - 1));
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    fromDate = fromDate || monday.toISOString().slice(0, 10);
    toDate   = toDate   || sunday.toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    return { ok: false, status: 400, error: 'fromDate / toDate must be YYYY-MM-DD' };
  }
  if (fromDate > toDate) {
    return { ok: false, status: 400, error: 'fromDate must be <= toDate' };
  }

  // Reference data — users (rates, Xero IDs), jobs (names)
  const [usersBlob, jobsBlob] = await Promise.all([
    readBlob('users.json', { users: [] }),
    readBlob('jobs.json',  { jobs: [] }),
  ]);
  const userById = {};
  for (const u of (usersBlob.users || [])) userById[u.id] = u;
  const jobById = {};
  for (const j of (jobsBlob.jobs || [])) jobById[j.id] = j;

  // Walk every user's time-entries (date-prefix filter applied at the
  // pathname level so we don't fetch entries outside the range).
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  let entryBlobs = [];
  try {
    // Fully paginated (#935): a silent 5000-blob cap on the payroll read
    // would drop hours with no error — the exact failure class this engine
    // now refuses.
    let cursor;
    do {
      const r = await list({ prefix: 'users/', token, limit: 1000, cursor });
      for (const b of (r && r.blobs) || []) {
        if (!b.pathname.includes('/time-entries/')) continue;
        if (b.pathname.includes('/time-entries-audit/')) continue;
        if (!b.pathname.endsWith('.json')) continue;
        const m = b.pathname.match(/\/time-entries\/(\d{4}-\d{2}-\d{2})\.json$/);
        if (!m) continue;
        const d = m[1];
        if (d < fromDate || d > toDate) continue;
        if (userId && !b.pathname.startsWith('users/' + userId + '/')) continue;
        entryBlobs.push(b);
      }
      cursor = r && r.hasMore ? r.cursor : undefined;
    } while (cursor);
  } catch (e) {
    return { ok: false, status: 502, error: 'blob list failed: ' + e.message };
  }

  const results = await Promise.all(
    entryBlobs.map(async (b) => ({ b, out: await fetchEntryVerified(b) })),
  );
  const entries = [];
  const refused = [];
  for (const { b, out } of results) {
    if (out.entry) entries.push(out.entry);
    else refused.push({ pathname: b.pathname, problem: out.problem });
  }
  if (refused.length) {
    // Never produce a payroll artifact missing real hours. Name the days so
    // the office knows exactly what to wait for / chase.
    const label = (r) => {
      const m = r.pathname.match(/^users\/([^/]+)\/time-entries\/(\d{4}-\d{2}-\d{2})/);
      const u = m ? userById[m[1]] : null;
      const who = (u && (u.name || u.username)) || (m ? m[1] : r.pathname);
      return (who + ' ' + (m ? m[2] : '') + ' (' + (r.problem === 'stale' ? 'just changed' : 'unreadable') + ')').trim();
    };
    const shown = refused.slice(0, 6).map(label).join('; ');
    return {
      ok: false,
      status: 503,
      error:
        'payroll read refused — ' + refused.length + ' day record(s) could not be read consistently: ' +
        shown + (refused.length > 6 ? '; …' : '') + '. ' +
        'Nothing was produced with missing hours — wait a minute and retry.',
    };
  }

  // Status filter — 'all' means everything, otherwise exact match.
  const filtered = entries.filter(e => status === 'all' ? true : e.status === status);

  // Build payroll rows. One row per allocation (a multi-job day produces
  // multiple rows with the same date + worker but different job + hours).
  const rows = [];
  for (const e of filtered) {
    const u = userById[e.userId] || {};
    const rate = (isFieldRole(u.role) || isLeadingHandRole(u.role)) ? Number(u.hourlyRate) || 0 : 0;
    const allAllocations = e.allocations || [];
    const prorated = prorateAllocations(e, allAllocations);
    const allocations = allAllocations
      .map((a, i) => ({ allocation: a, split: prorated[i] }))
      .filter(({ allocation: a }) => !jobId || a.jobId === jobId);
    if (!allocations.length) continue;
    for (const { allocation: a, split } of allocations) {
      const j = a.jobId ? jobById[a.jobId] : null;
      const hours = split.hours;
      rows.push({
        weekStart: weekMondayOf(e.date),
        weekEnd:   weekSundayOf(e.date),
        date:      e.date,
        // LIVE name first (owner-directed 2026-08-09): the stamp is frozen at
        // write time and goes stale on rename; the user record is the truth.
        workerName: u.name || e.userName || u.username || e.userId,
        workerId:   e.userId,
        // Role rides on the row so the payroll partition can exclude
        // outside-payroll workers (subcontractors invoice directly) without
        // another users.json read.
        workerRole: u.role || null,
        xeroEmployeeId: u.xeroEmployeeId || '',
        // Job-less day types ride the row (2026-08-10) so the payroll
        // partition can keep sick/holiday hours out of the wages push (they
        // are entered as leave in Xero) without another entry read; TAFE
        // pushes as ordinary wages and names itself instead of "no job".
        dayType:    e.dayType || null,
        jobName:    j
          ? j.name
          : e.dayType === 'tafe'
            ? 'TAFE'
            : e.dayType === 'sick'
              ? 'Sick day'
              : e.dayType === 'holiday'
                ? 'Holiday'
                : a.jobId
                  ? '(unknown job)'
                  : 'Internal — no job',
        jobId:      a.jobId || '',
        hours:      hours,
        ordinaryHours: split.ordinaryHours,
        overtimeHours: split.overtimeHours,
        rateExGst:  rate,
        lineCostExGst: Math.round(hours * rate * 100) / 100,
        notes:      String(a.notes || e.notes || '').replace(/\r?\n/g, ' ').trim(),
        status:     e.status,
        approvedBy: e.approvedBy ? (userById[e.approvedBy] || {}).username || e.approvedBy : '',
        approvedAt: e.approvedAt || '',
        exportedAt: e.exportedAt || '',
        exportId:   e.exportId || '',
      });
    }
  }
  // Stable sort: date, worker, job
  rows.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    a.workerName.localeCompare(b.workerName) ||
    a.jobName.localeCompare(b.jobName));

  // #248/#249: the CONFIRMED worker↔employee links live in Postgres
  // (xero_mappings) — users.json's free-text xeroEmployeeId predates them and
  // goes stale on every reconnect, which left the pay-period page showing
  // "No Xero id / Needs action" for workers whose links were confirmed and
  // whose batch passed validation (live find, 2026-07-25). A confirmed link
  // wins; the legacy field stands when Xero is disconnected or PG is
  // unreachable, so the CSV keeps working as the permanent fallback.
  const workerIds = [...new Set(rows.map(r => r.workerId))];
  if (workerIds.length) {
    try {
      const { mappingReadiness } = require('./xero/worker-mappings');
      const readiness = await mappingReadiness(workerIds);
      const confirmed = new Map(
        readiness.filter(m => m.mapped && m.employeeId).map(m => [m.workerId, m.employeeId]));
      for (const r of rows) {
        const employeeId = confirmed.get(r.workerId);
        if (employeeId) r.xeroEmployeeId = employeeId;
      }
    } catch { /* not connected / PG unreachable → legacy field stands */ }
  }

  return { ok: true, fromDate, toDate, status, userId, jobId, rows, entries, userById, jobById };
}

function weekMondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay() || 7;
  const m = new Date(d); m.setDate(d.getDate() - (dow - 1));
  return m.toISOString().slice(0, 10);
}
function weekSundayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay() || 7;
  const s = new Date(d); s.setDate(d.getDate() + (7 - dow));
  return s.toISOString().slice(0, 10);
}

module.exports = { collectRows, weekMondayOf, weekSundayOf, __setFreshnessRetryDelaysForTests };
