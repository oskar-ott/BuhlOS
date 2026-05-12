// Hot-areas — areas/dwellings with the most snag activity.
//
//   GET /api/hot-areas?jobId=<id>&limit=20
//
// Per-job (jobId set) or cross-job (omit jobId, scoped by role).
// Counts snags per area/dwelling: total, open, closed, plus open-by-
// priority. Sorted total desc, then high-open desc.
//
// For the "where's the pain on this job?" widget — admin clicks into
// the dwelling with the most snags to focus a site visit or LH push.
//
// Response (per-job mode):
//   {
//     scope: 'job',
//     jobId, jobName,
//     areas: [{
//       dwellingId, dwellingName,
//       total, open, closed,
//       highOpen, mediumOpen, lowOpen
//     }]
//   }
//
// Cross-job mode adds `jobId` + `jobName` to each row and replaces
// scope: 'cross'. Active jobs only; LH scoped to assignedJobIds.
//
// Permissions: admin / LH; tradies/clients 403.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob } = require('./_lib/auth');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res);
  if (!me) return;
  if (!['admin', 'leadingHand'].includes(me.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const q = req.query || {};
  const jobIdQ = q.jobId || '';
  let limit = parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  if (limit > 200) limit = 200;

  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const allJobs = jobsBlob.jobs || [];

  let walk;
  let scope, jobName;
  if (jobIdQ) {
    const job = allJobs.find(j => j.id === jobIdQ);
    if (!job) return res.status(404).json({ error: 'job not found' });
    if (!canManageJob(me, jobIdQ)) return res.status(403).json({ error: 'no access to job' });
    walk = [job];
    scope = 'job';
    jobName = job.name;
  } else {
    const active = allJobs.filter(j => (j.status || 'active') === 'active');
    walk = me.role === 'admin'
      ? active
      : active.filter(j => (me.assignedJobIds || []).includes(j.id));
    scope = 'cross';
  }

  // Per-job: build areaName lookup + count snags per dwelling.
  const out = [];

  await Promise.all(walk.map(async j => {
    let data;
    try { data = await readBlob(`jobs/${j.id}/data.json`, { snags: [] }); }
    catch { return; }

    const areaNameById = {};
    for (const g of (j.areaGroups || [])) {
      for (const a of (g.areas || [])) areaNameById[a.id] = a.name;
    }

    // Per-dwelling buckets. Use a Map so we can preserve insertion order
    // for unknown dwellings (snags filed against an area later deleted).
    const buckets = new Map();
    const get = (dwId) => {
      if (!buckets.has(dwId)) {
        buckets.set(dwId, {
          dwellingId: dwId,
          dwellingName: areaNameById[dwId] || dwId || '(unspecified)',
          total: 0, open: 0, closed: 0,
          highOpen: 0, mediumOpen: 0, lowOpen: 0,
        });
      }
      return buckets.get(dwId);
    };

    for (const s of (data.snags || [])) {
      const dwId = s.dwelling || '';
      const b = get(dwId);
      b.total++;
      const isOpen = (s.status || 'Open') === 'Open';
      if (isOpen) b.open++; else b.closed++;
      if (isOpen) {
        const prio = s.priority || 'Medium';
        if (prio === 'High')   b.highOpen++;
        else if (prio === 'Low') b.lowOpen++;
        else                     b.mediumOpen++;
      }
    }

    for (const b of buckets.values()) {
      // Skip rows with 0 total (defensive — shouldn't happen).
      if (b.total === 0) continue;
      if (scope === 'cross') {
        b.jobId = j.id;
        b.jobName = j.name;
      }
      out.push(b);
    }
  }));

  // Sort: total desc, then highOpen desc, then dwellingName.
  out.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    if (b.highOpen !== a.highOpen) return b.highOpen - a.highOpen;
    return (a.dwellingName || '').localeCompare(b.dwellingName || '');
  });

  const payload = scope === 'job'
    ? { scope, jobId: jobIdQ, jobName, areas: out.slice(0, limit) }
    : { scope, jobsInScope: walk.length, areas: out.slice(0, limit) };
  return res.status(200).json(payload);
};
