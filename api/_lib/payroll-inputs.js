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

const { list } = require('@vercel/blob');
const { readBlob } = require('./blob');
const { isLeadingHandRole, isFieldRole } = require('./auth');
const { prorateAllocations } = require('./payroll-rows');

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
    const r = await list({ prefix: 'users/', token, limit: 5000 });
    entryBlobs = (r.blobs || []).filter(b => {
      if (!b.pathname.includes('/time-entries/')) return false;
      if (b.pathname.includes('/time-entries-audit/')) return false;
      if (!b.pathname.endsWith('.json')) return false;
      const m = b.pathname.match(/\/time-entries\/(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) return false;
      const d = m[1];
      if (d < fromDate || d > toDate) return false;
      if (userId && !b.pathname.startsWith('users/' + userId + '/')) return false;
      return true;
    });
  } catch (e) {
    return { ok: false, status: 502, error: 'blob list failed: ' + e.message };
  }

  const entries = (await Promise.all(entryBlobs.map(async b => {
    try {
      const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }))).filter(Boolean);

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
        workerName: e.userName || u.username || e.userId,
        workerId:   e.userId,
        // Role rides on the row so the payroll partition can exclude
        // outside-payroll workers (subcontractors invoice directly) without
        // another users.json read.
        workerRole: u.role || null,
        xeroEmployeeId: u.xeroEmployeeId || '',
        jobName:    j ? j.name : (a.jobId ? '(unknown job)' : 'Internal — no job'),
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

module.exports = { collectRows, weekMondayOf, weekSundayOf };
