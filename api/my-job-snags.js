// "My snags" view scoped to a single job, for the mobile job page.
//
//   GET /api/my-job-snags?jobId=<id>
//
// Returns the snags on this job that involve the current user, in four
// buckets keyed by relevance to a tradie's day:
//
//   assignedOpen   — assigned to me, still Open    (most actionable)
//   raisedOpen     — raised by me, still Open, NOT assigned to me
//                    (so I can chase the LH if it's languishing)
//   assignedClosed — assigned to me, Closed recently (last 14 days)
//   raisedClosed   — raised by me, Closed recently
//
// The 14-day "recent" window keeps the closed lists from accumulating
// forever; older entries are reachable via the global /admin/snags or
// /api/snags-mine endpoints.
//
// Distinct from /api/snags-mine: this one is per-job (so the mobile
// job page can show a focused "my snags here" tab) and includes the
// raised-but-not-assigned bucket — a tradie who files a snag wants to
// see whether it actually got picked up.
//
// Response:
//   {
//     job: { id, name },
//     counts: { assignedOpen, raisedOpen, assignedClosed, raisedClosed },
//     assignedOpen:   [...],
//     raisedOpen:     [...],
//     assignedClosed: [...],
//     raisedClosed:   [...]
//   }
//
// Snag rows carry the same fields as /api/snags-all (#73 territory).
//
// Permissions: write access (admin / LH / tradie assigned). Client: 403.

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_DAYS = 14;

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const me = await requireAuth(req, res, { jobId });
  if (!me) return;
  if (me.role === 'client') return res.status(403).json({ error: 'forbidden' });
  if (!canWrite(me, jobId) && me.role !== 'admin') {
    return res.status(403).json({ error: 'no access to job' });
  }

  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const job = (jobsBlob.jobs || []).find(j => j.id === jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  const areaName = {};
  for (const g of (job.areaGroups || [])) {
    for (const a of (g.areas || [])) areaName[a.id] = a.name;
  }

  const data = await readBlob(`jobs/${jobId}/data.json`, { snags: [] });
  const recentCutoff = Date.now() - RECENT_DAYS * DAY_MS;

  const mapSnag = (s) => ({
    id: s.id,
    desc: s.desc || '',
    priority: s.priority || 'Medium',
    status: s.status || 'Open',
    dwelling: s.dwelling || null,
    dwellingName: areaName[s.dwelling] || s.dwelling || null,
    stage: s.stage || '',
    by: s.by || '',
    createdAt: s.createdAt || s.date || '',
    closedAt: s.closedAt || null,
    photoCount: (s.photos || []).length,
    assignedToUserId: s.assignedToUserId || null,
    assignedToName: s.assignedToName || null,
    autoAssigned: !!s.autoAssigned,
  });

  const assignedOpen   = [];
  const raisedOpen     = [];
  const assignedClosed = [];
  const raisedClosed   = [];

  for (const s of (data.snags || [])) {
    if (!s) continue;
    const isOpen = (s.status || 'Open') === 'Open';
    const mineAssigned = s.assignedToUserId === me.id;
    const mineRaised   = s.by === me.username;          // by stores username; same as data.js POST
    if (!mineAssigned && !mineRaised) continue;

    const row = mapSnag(s);

    if (mineAssigned && isOpen) {
      assignedOpen.push(row);
      continue;
    }
    if (mineRaised && isOpen && !mineAssigned) {
      raisedOpen.push(row);
      continue;
    }
    // Closed branches — restrict to recent.
    const closedT = s.closedAt ? Date.parse(s.closedAt) : NaN;
    if (!Number.isFinite(closedT) || closedT < recentCutoff) continue;
    if (mineAssigned) assignedClosed.push(row);
    else if (mineRaised) raisedClosed.push(row);
  }

  // Sort: open by priority then oldest; closed by closedAt desc.
  const prioRank = { High: 0, Medium: 1, Low: 2 };
  const sortOpen = (a, b) => {
    const p = (prioRank[a.priority] ?? 1) - (prioRank[b.priority] ?? 1);
    if (p !== 0) return p;
    return (a.createdAt || '').localeCompare(b.createdAt || '');
  };
  const sortClosed = (a, b) => (b.closedAt || '').localeCompare(a.closedAt || '');
  assignedOpen.sort(sortOpen);
  raisedOpen.sort(sortOpen);
  assignedClosed.sort(sortClosed);
  raisedClosed.sort(sortClosed);

  return res.status(200).json({
    job: { id: job.id, name: job.name },
    counts: {
      assignedOpen: assignedOpen.length,
      raisedOpen: raisedOpen.length,
      assignedClosed: assignedClosed.length,
      raisedClosed: raisedClosed.length,
    },
    assignedOpen, raisedOpen, assignedClosed, raisedClosed,
  });
};
