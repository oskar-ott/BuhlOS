// Mobile work-areas list — every dwelling with progress + open-snag count.
//
//   GET /api/job-areas?jobId=<id>&sort=group|name|progress|snags
//
// Returns the per-area summary rows that the mobile "Work Areas" screen
// (Phase 04 of the unmerged stack) renders as a scrollable list — each
// row is one dwelling with progress % and open-snag count, grouped by
// area-group.
//
// Sort modes (`?sort=`):
//   group      (default) — preserve the job's own group/area order
//   name       — alphabetical by area name
//   progress   — most-complete first
//   snags      — most-open-snags first (the "where's the action" view)
//
// Response:
//   {
//     job: { id, name },
//     groups: [{ name, areas: [...] }],   // when sort=group
//     areas:  [...]                       // when any other sort (flat)
//   }
//
// Each area row:
//   {
//     id, name, group, spaceType,
//     progress: { roughInPct, fitOffPct, overallPct, isComplete },
//     snags:    { open, openHigh },
//     myAssignedSnags                     // open snags assigned to *me*
//   }
//
// Permissions: write access (admin / LH / tradie). Client → 403; the
// portal already shows the client-safe view via /api/client-update.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  const sort = (req.query.sort || 'group').toLowerCase();

  const me = await requireAuth(req, res, { jobId });
  if (!me) return;
  if (me.role === 'client') return res.status(403).json({ error: 'forbidden' });
  if (!canWrite(me, jobId) && me.role !== 'admin') {
    return res.status(403).json({ error: 'no access to job' });
  }

  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const job = (jobsBlob.jobs || []).find(j => j.id === jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  const data = await readBlob(`jobs/${jobId}/data.json`, { dwellings: {}, snags: [] });
  const dwellings = data.dwellings || {};

  // Bucket snag counts per dwelling, including the "assigned to me" view.
  const snagBucket = {};   // areaId → { open, openHigh, mine }
  for (const s of (data.snags || [])) {
    if ((s.status || 'Open') !== 'Open') continue;
    const dwId = s.dwelling || '';
    const b = (snagBucket[dwId] = snagBucket[dwId] || { open: 0, openHigh: 0, mine: 0 });
    b.open++;
    if ((s.priority || 'Medium') === 'High') b.openHigh++;
    if (s.assignedToUserId === me.id) b.mine++;
  }

  // Build per-area rows.
  const jobRt = job.roughInTasks || [];
  const jobFt = job.fitOffTasks  || [];
  const effRough = (a) => (Array.isArray(a.roughInTasks) && a.roughInTasks.length) ? a.roughInTasks : jobRt;
  const effFit   = (a) => (Array.isArray(a.fitOffTasks)  && a.fitOffTasks.length)  ? a.fitOffTasks  : jobFt;

  const groups = [];
  const flat   = [];
  for (const g of (job.areaGroups || [])) {
    const groupOut = { name: g.name, areas: [] };
    for (const a of (g.areas || [])) {
      const rMap = ((dwellings[a.id] || {}).roughIn || {}).tasks || {};
      const fMap = ((dwellings[a.id] || {}).fitOff  || {}).tasks || {};
      const aRt = effRough(a), aFt = effFit(a);
      let rPct = null, fPct = null;
      if (aRt.length) rPct = Math.round(aRt.filter(t => rMap[t.id] === 'complete').length / aRt.length * 100);
      if (aFt.length) fPct = Math.round(aFt.filter(t => fMap[t.id] === 'complete').length / aFt.length * 100);
      const parts = [rPct, fPct].filter(v => v !== null);
      const oPct  = parts.length ? Math.round(parts.reduce((s, v) => s + v, 0) / parts.length) : 0;
      const b = snagBucket[a.id] || { open: 0, openHigh: 0, mine: 0 };
      const row = {
        id: a.id, name: a.name,
        group: g.name,
        spaceType: a.spaceType || null,
        progress: {
          roughInPct: rPct,
          fitOffPct:  fPct,
          overallPct: oPct,
          isComplete: parts.length > 0 && oPct === 100,
        },
        snags: { open: b.open, openHigh: b.openHigh },
        myAssignedSnags: b.mine,
      };
      groupOut.areas.push(row);
      flat.push(row);
    }
    groups.push(groupOut);
  }

  if (sort === 'group') {
    return res.status(200).json({
      job: { id: job.id, name: job.name },
      sort,
      groups,
    });
  }

  // Flat sorts.
  if (sort === 'name') {
    flat.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } else if (sort === 'progress') {
    flat.sort((a, b) => (b.progress.overallPct - a.progress.overallPct)
      || (a.name || '').localeCompare(b.name || ''));
  } else if (sort === 'snags') {
    flat.sort((a, b) => {
      if (b.snags.open !== a.snags.open) return b.snags.open - a.snags.open;
      if (b.snags.openHigh !== a.snags.openHigh) return b.snags.openHigh - a.snags.openHigh;
      return (a.name || '').localeCompare(b.name || '');
    });
  } else {
    return res.status(400).json({ error: 'sort must be one of: group, name, progress, snags' });
  }

  return res.status(200).json({
    job: { id: job.id, name: job.name },
    sort,
    areas: flat,
  });
};
