// Mobile area drill-down — everything about a single dwelling.
//
//   GET /api/area-detail?jobId=<id>&areaId=<id>
//
// Returns the per-area view the mobile "Area Work" page (Phase 05 of
// the unmerged stack) opens onto: rough-in tasks + fit-off tasks with
// their current state, open & resolved snags scoped to that area, and
// any ITP photos already on file. Single fetch, single paint.
//
// Why this exists:
//   The mobile job page (Phase 03) drills down: Job → Area → Task →
//   Done. The area screen is where most field-side work happens, so
//   it needs to load fast on a phone over patchy site wifi. Pulling
//   the whole job's data blob would force the page to filter it
//   client-side; this endpoint does the filter server-side and ships
//   only what the area screen needs.
//
// Response:
//   {
//     job:   { id, name },
//     area:  { id, name, group },
//     tasks: {
//       roughIn: [{ id, name, state }],     // state: not_started | in_progress | complete
//       fitOff:  [{ id, name, state }]
//     },
//     progress: { roughInPct, fitOffPct, overallPct },
//     snags: {
//       open:     [{ id, desc, priority, by, createdAt, photoCount,
//                    assignedToUserId, assignedToName }],
//       resolved: [{ id, desc, closedAt, updatedBy }]
//     },
//     photos: [{ id, url, addedBy, addedAt, stage }]
//   }
//
// Permissions:
//   - admin / leadingHand / tradie with write access to the job
//   - client: 403 (use /api/client-update for sanitised summary)

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite, isAdminRole } = require('./_lib/auth');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const jobId  = (req.query && req.query.jobId)  || '';
  const areaId = (req.query && req.query.areaId) || '';
  if (!jobId)  return res.status(400).json({ error: 'jobId required' });
  if (!areaId) return res.status(400).json({ error: 'areaId required' });

  const me = await requireAuth(req, res, { jobId });
  if (!me) return;
  if (me.role === 'client') return res.status(403).json({ error: 'forbidden' });
  if (!canWrite(me, jobId) && !isAdminRole(me.role)) {
    return res.status(403).json({ error: 'no access to job' });
  }

  // Locate the area within the job and grab its group label.
  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const job = (jobsBlob.jobs || []).find(j => j.id === jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  let areaRec = null;
  let groupName = null;
  for (const g of (job.areaGroups || [])) {
    for (const a of (g.areas || [])) {
      if (a.id === areaId) { areaRec = a; groupName = g.name; break; }
    }
    if (areaRec) break;
  }
  if (!areaRec) return res.status(404).json({ error: 'area not found on job' });

  const data = await readBlob(`jobs/${jobId}/data.json`, { dwellings: {}, snags: [] });
  const dwellings = data.dwellings || {};
  const dwState = dwellings[areaId] || {};

  // Effective task lists (per-area override beats job-level default).
  const effRough = (Array.isArray(areaRec.roughInTasks) && areaRec.roughInTasks.length)
    ? areaRec.roughInTasks
    : (job.roughInTasks || []);
  const effFit = (Array.isArray(areaRec.fitOffTasks) && areaRec.fitOffTasks.length)
    ? areaRec.fitOffTasks
    : (job.fitOffTasks || []);
  const rMap = (dwState.roughIn || {}).tasks || {};
  const fMap = (dwState.fitOff  || {}).tasks || {};

  const roughInTasks = effRough.map(t => ({
    id: t.id, name: t.name,
    state: rMap[t.id] || 'not_started',
  }));
  const fitOffTasks = effFit.map(t => ({
    id: t.id, name: t.name,
    state: fMap[t.id] || 'not_started',
  }));

  const completedR = roughInTasks.filter(t => t.state === 'complete').length;
  const completedF = fitOffTasks.filter(t => t.state === 'complete').length;
  const roughInPct = roughInTasks.length ? Math.round(completedR / roughInTasks.length * 100) : 0;
  const fitOffPct  = fitOffTasks.length  ? Math.round(completedF / fitOffTasks.length  * 100) : 0;
  const parts = [];
  if (roughInTasks.length) parts.push(roughInPct);
  if (fitOffTasks.length)  parts.push(fitOffPct);
  const overallPct = parts.length
    ? Math.round(parts.reduce((s, v) => s + v, 0) / parts.length)
    : 0;

  // Snags scoped to this area.
  const open = [];
  const resolved = [];
  for (const s of (data.snags || [])) {
    if (s.dwelling !== areaId) continue;
    if ((s.status || 'Open') === 'Open') {
      open.push({
        id: s.id, desc: s.desc || '',
        priority: s.priority || 'Medium',
        by: s.by || '',
        createdAt: s.createdAt || s.date || '',
        photoCount: (s.photos || []).length,
        assignedToUserId: s.assignedToUserId || null,
        assignedToName:   s.assignedToName   || null,
      });
    } else {
      resolved.push({
        id: s.id, desc: s.desc || '',
        closedAt: s.closedAt || '',
        updatedBy: s.updatedBy || null,
      });
    }
  }
  // Open: High first then oldest; resolved: most recently closed first.
  const prioRank = { High: 0, Medium: 1, Low: 2 };
  open.sort((a, b) => {
    const p = (prioRank[a.priority] ?? 1) - (prioRank[b.priority] ?? 1);
    if (p !== 0) return p;
    return (a.createdAt || '').localeCompare(b.createdAt || '');
  });
  resolved.sort((a, b) => (b.closedAt || '').localeCompare(a.closedAt || ''));

  // Per-area ITP photos (the photos-index keyed by dwelling).
  let photos = [];
  try {
    const idx = await readBlob(`jobs/${jobId}/photos-index.json`, {});
    const stages = idx[areaId] || {};
    for (const [stage, plist] of Object.entries(stages || {})) {
      if (!Array.isArray(plist)) continue;
      for (const p of plist) {
        if (!p || !p.url) continue;
        photos.push({
          id: p.id || '',
          url: p.url,
          addedBy: p.addedBy || '',
          addedAt: p.addedAt || '',
          stage,
        });
      }
    }
  } catch { /* swallow — empty photos list is fine */ }
  photos.sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));

  return res.status(200).json({
    job: { id: job.id, name: job.name },
    area: { id: areaRec.id, name: areaRec.name, group: groupName, spaceType: areaRec.spaceType || null },
    tasks: { roughIn: roughInTasks, fitOff: fitOffTasks },
    progress: { roughInPct, fitOffPct, overallPct },
    snags: { open, resolved: resolved.slice(0, 20) },
    photos,
  });
};
