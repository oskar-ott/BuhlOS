// Cross-job snag listing for admin / leading hand.
//
//   GET /api/snags-all
//     ?status=Open|Closed|all     (default: Open)
//     ?priority=High|Medium|Low   (optional)
//     ?jobId=<id>                 (optional — restrict to one job)
//     ?assignedToUserId=<id>      (optional — restrict to one assignee;
//                                  use 'unassigned' to filter to no-assignee)
//
// Response: { snags: [{ id, jobId, jobName, jobStatus,
//                       desc, priority, status, dwelling, dwellingName, stage,
//                       assignedToUserId, assignedToName,
//                       by, createdAt, photoCount }] }
//
// Walks all visible jobs in parallel, reads each data.json, flattens snags,
// applies filters. Sorted by priority (High→Low), then oldest open first.
//
// Permissions:
//   - admin: all jobs
//   - leadingHand: only jobs in their assignedJobIds
//   - everyone else: 403

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

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
  const wantStatus  = q.status || 'Open';
  const wantPrio    = q.priority || '';
  const wantJobId   = q.jobId || '';
  const wantAssign  = q.assignedToUserId || '';

  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const allJobs = jobsBlob.jobs || [];
  let visible = (me.role === 'admin')
    ? allJobs
    : allJobs.filter(j => (me.assignedJobIds || []).includes(j.id));
  if (wantJobId) visible = visible.filter(j => j.id === wantJobId);

  const collected = await Promise.all(visible.map(async job => {
    let data;
    try {
      data = await readBlob('jobs/' + job.id + '/data.json', { dwellings: {}, snags: [] });
    } catch (e) { return []; }
    const areaName = {};
    for (const g of (job.areaGroups || [])) {
      for (const a of (g.areas || [])) areaName[a.id] = a.name;
    }
    return (data.snags || []).filter(s => {
      if (wantStatus !== 'all' && s.status !== wantStatus) return false;
      if (wantPrio   && (s.priority || 'Medium') !== wantPrio) return false;
      if (wantAssign === 'unassigned') { if (s.assignedToUserId) return false; }
      else if (wantAssign && s.assignedToUserId !== wantAssign) return false;
      return true;
    }).map(s => ({
      id: s.id,
      jobId: job.id,
      jobName: job.name,
      jobStatus: job.status || 'active',
      desc: s.desc || '',
      priority: s.priority || 'Medium',
      status: s.status || 'Open',
      dwelling: s.dwelling,
      dwellingName: areaName[s.dwelling] || s.dwelling,
      stage: s.stage || '',
      assignedToUserId: s.assignedToUserId || null,
      assignedToName: s.assignedToName || null,
      by: s.by || '',
      createdAt: s.createdAt || s.date || '',
      closedAt: s.closedAt || null,
      // updatedBy is set whenever the snag is mutated (close/reopen/edit).
      // For Closed snags it doubles as "resolved by", which the admin tab
      // now surfaces in the row meta line.
      updatedBy: s.updatedBy || null,
      photoCount: (s.photos || []).length,
    }));
  }));

  // Flatten + sort: open-first, then priority desc, then oldest createdAt first
  const prioRank = { High: 0, Medium: 1, Low: 2 };
  const snags = [].concat.apply([], collected).sort((a, b) => {
    if (a.status !== b.status) return a.status === 'Open' ? -1 : 1;
    const pr = (prioRank[a.priority] ?? 1) - (prioRank[b.priority] ?? 1);
    if (pr !== 0) return pr;
    return (a.createdAt || '').localeCompare(b.createdAt || '');
  });

  return res.status(200).json({ snags, jobs: visible.map(j => ({ id: j.id, name: j.name })) });
};
