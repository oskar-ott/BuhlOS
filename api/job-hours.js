// Per-job hours read (#134) — recompute-on-read foundation for job labour burn.
//
//   GET /api/job-hours?jobId=X        (admin tier only)
//     → { jobId, entries: [...], asOf }
//
// Returns THIS job's time entries in {submitted, approved} (never draft/rejected),
// across all workers, with their allocations — the input the pure
// summariseJobHours (src/domains/jobs/job-hours.ts) buckets into approved vs
// pending hours by status. There is NO summation here: ONE engine, run on the
// consumer side, so the page totals can never diverge from the approver queue.
//
// Names (#1027): each entry's `userName` is overlaid with the LIVE full name —
// the same resolver the hours boards use (api/_lib/worker-names.js, #1020:
// register "First Last" → users.json name → stored snapshot → username). The
// stored snapshot is write-time and nickname-era ("Mr Borg") — the Labour card
// must read "Jonathan Borg" like the payroll PDF does. Identity stays `userId`.
//
// v1 STORAGE NOTE (accepted, documented): there is no per-job hours index, so
// this RECOMPUTES from a full users/ blob scan per call
// (listAllEntriesForApprovers). Acceptable at current scale; a maintained index
// is a deliberate later step only if the scan cost bites — and recompute-from-
// source stays the source of truth regardless, since the blob store has no
// atomic CAS. Blob remains authoritative; no Postgres read here.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole } = require('./_lib/auth');
const { listAllEntriesForApprovers } = require('./_lib/time-entries');
const { buildWorkerLabeller } = require('./_lib/worker-names');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  // Job labour/cost is office data — admin tier only.
  const viewer = await requireAuth(req, res);
  if (!viewer) return;
  if (!isAdminRole(viewer.role)) return res.status(403).json({ error: 'forbidden' });

  let all, usersBlob, empBlob;
  try {
    [all, usersBlob, empBlob] = await Promise.all([
      listAllEntriesForApprovers({ statuses: ['submitted', 'approved'] }),
      readBlob('users.json', { users: [] }),
      readBlob('employees.json', { employees: [] }),
    ]);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  const labelFor = buildWorkerLabeller({
    users: usersBlob && usersBlob.users,
    employees: empBlob && empBlob.employees,
  });

  // An entry belongs to this job if ANY allocation targets it. Null-job
  // (overhead / "send to office") allocations never match a real jobId.
  // Full entries (same shape as the scope=approver queue → drop-in for the
  // existing hours parser + summariseJobHours); the consumer buckets by status.
  // Only `userName` is touched: the live full name, never the stored nickname.
  const entries = all
    .filter(e => Array.isArray(e.allocations) && e.allocations.some(a => a && a.jobId === jobId))
    .map(e => ({ ...e, userName: labelFor(e.userId, e.userName) }));

  return res.status(200).json({ jobId, entries, asOf: new Date().toISOString() });
};
