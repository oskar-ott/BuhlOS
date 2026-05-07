// Cross-job listing of snags relevant to the current user.
//
//   GET /api/snags-mine
//     ?status=Open|Closed|all  (default: Open)
//     ?view=assigned|raised    (default: assigned)
//        - assigned: snags where assignedToUserId === me.id
//        - raised:   snags where createdByUserId === me.id
//                    (used to surface "snags I raised that have since been
//                    resolved" on /my-day)
//
// Response: { snags: [{ id, jobId, jobName, desc, priority, status,
//                       dwelling, dwellingName, by, createdAt, closedAt,
//                       photoCount }] }
//
// Walks all jobs the user has visibility into (admin sees all jobs; everyone
// else sees jobs in their assignedJobIds), then reads each job's data.json
// to find matching snags.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res);
  if (!me) return;
  if (me.role === 'client') return res.status(403).json({ error: 'forbidden' });

  const q = req.query || {};
  const status = q.status || 'Open';
  const view   = (q.view === 'raised') ? 'raised' : 'assigned';

  // Which jobs to scan? Admin: all. LH/tradie: assignedJobIds.
  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const allJobs = jobsBlob.jobs || [];
  const visible = (me.role === 'admin')
    ? allJobs
    : allJobs.filter(j => (me.assignedJobIds || []).includes(j.id));

  // Read each job's data.json in parallel and collect matching snags.
  const collected = await Promise.all(visible.map(async job => {
    let data;
    try {
      data = await readBlob('jobs/' + job.id + '/data.json', { dwellings: {}, snags: [] });
    } catch (e) {
      return [];
    }
    // Build a quick areaId → name lookup once per job
    const areaName = {};
    for (const g of (job.areaGroups || [])) {
      for (const a of (g.areas || [])) areaName[a.id] = a.name;
    }
    const matchUser = view === 'raised'
      ? (s => s.createdByUserId === me.id)
      : (s => s.assignedToUserId === me.id);
    return (data.snags || [])
      .filter(matchUser)
      .filter(s => status === 'all' || s.status === status)
      .map(s => ({
        id: s.id,
        jobId: job.id,
        jobName: job.name,
        desc: s.desc || '',
        priority: s.priority || 'Medium',
        status: s.status || 'Open',
        dwelling: s.dwelling,
        dwellingName: areaName[s.dwelling] || s.dwelling,
        stage: s.stage || '',
        by: s.by || '',
        createdAt: s.createdAt || s.date || '',
        closedAt: s.closedAt || null,
        updatedBy: s.updatedBy || null,
        photoCount: (s.photos || []).length,
      }));
  }));

  // Flatten + sort.
  // For 'raised' view of resolved snags, prefer most-recently-closed first
  // — that's how /my-day's "Recently resolved" panel reads.
  // Otherwise: priority desc, then oldest-open-first.
  const prioRank = { High: 0, Medium: 1, Low: 2 };
  const snags = [].concat.apply([], collected).sort((a, b) => {
    if (view === 'raised' && status === 'Closed') {
      return (b.closedAt || '').localeCompare(a.closedAt || '');
    }
    const pr = (prioRank[a.priority] ?? 1) - (prioRank[b.priority] ?? 1);
    if (pr !== 0) return pr;
    return (a.createdAt || '').localeCompare(b.createdAt || '');
  });

  return res.status(200).json({ snags });
};
