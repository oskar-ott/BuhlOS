// Client multi-job summary.
//
//   GET /api/client-jobs-summary
//
// For a client who owns more than one job (renovator with several
// units, builder with multiple sites): returns a one-line summary per
// job with progress %, open client-visible snag count, and last
// activity timestamp. Powers the picker page in /client.html when more
// than one job is visible.
//
// Currently the portal walks each job's data blob client-side to
// compute these numbers — wasteful and slow on a phone. Server-side
// roll-up trims the bundle and gives one snappy fetch instead of N.
//
// Response:
//   {
//     count,
//     jobs: [{
//       id, name, type, status,
//       progress: { roughInPct, fitOffPct, overallPct, areasCount },
//       snags:    { openVisible },
//       lastActivityAt
//     }]
//   }
//
// Permissions:
//   - client: only the jobs where clientUserId === me.id
//   - admin / leadingHand: not the target audience but allowed (returns
//     every job they could see) — kept role-agnostic so a unified
//     header widget can hit it without branching
//   - everyone else: 401 / 403 from auth as usual

const { readBlob, setNoCache } = require('./_lib/blob');
const { getCurrentUser } = require('./_lib/auth');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'not authenticated' });

  // Resolve visible jobs by role.
  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const allJobs  = jobsBlob.jobs || [];
  let visible;
  if (me.role === 'admin') {
    visible = allJobs;
  } else if (me.role === 'leadingHand') {
    visible = allJobs.filter(j => (me.assignedJobIds || []).includes(j.id));
  } else if (me.role === 'tradie') {
    // Tradies aren't the audience but they technically have access to
    // their jobs via /api/jobs already — return a minimal stub.
    visible = allJobs.filter(j => (me.assignedJobIds || []).includes(j.id));
  } else if (me.role === 'client') {
    visible = allJobs.filter(j => j.clientUserId === me.id);
  } else {
    return res.status(403).json({ error: 'forbidden' });
  }

  // Per-job rollup in parallel.
  const rows = await Promise.all(visible.map(async j => {
    let data;
    try { data = await readBlob(`jobs/${j.id}/data.json`, { dwellings: {}, snags: [] }); }
    catch { data = { dwellings: {}, snags: [] }; }

    // Progress (same math as /client.html and /api/client-update).
    const areas = (j.areaGroups || []).flatMap(g => g.areas || []);
    const dwellings = data.dwellings || {};
    const jobRt = j.roughInTasks || [];
    const jobFt = j.fitOffTasks  || [];
    const effRough = (a) => (Array.isArray(a.roughInTasks) && a.roughInTasks.length) ? a.roughInTasks : jobRt;
    const effFit   = (a) => (Array.isArray(a.fitOffTasks)  && a.fitOffTasks.length)  ? a.fitOffTasks  : jobFt;
    let rSum = 0, fSum = 0, rCount = 0, fCount = 0;
    for (const a of areas) {
      const rMap = ((dwellings[a.id] || {}).roughIn || {}).tasks || {};
      const fMap = ((dwellings[a.id] || {}).fitOff  || {}).tasks || {};
      const aRt = effRough(a), aFt = effFit(a);
      if (aRt.length) {
        rSum += aRt.filter(t => rMap[t.id] === 'complete').length / aRt.length;
        rCount++;
      }
      if (aFt.length) {
        fSum += aFt.filter(t => fMap[t.id] === 'complete').length / aFt.length;
        fCount++;
      }
    }
    const roughInPct = rCount ? Math.round(rSum / rCount * 100) : 0;
    const fitOffPct  = fCount ? Math.round(fSum / fCount * 100) : 0;
    const overallPct = (rCount || fCount)
      ? Math.round((rCount && fCount) ? (roughInPct + fitOffPct) / 2 : (rCount ? roughInPct : fitOffPct))
      : 0;

    // Open client-visible snags + lastActivity.
    let openVisible = 0;
    let lastActivityAt = '';
    for (const s of (data.snags || [])) {
      for (const ts of [s.createdAt, s.closedAt, s.updatedAt]) {
        if (ts && ts > lastActivityAt) lastActivityAt = ts;
      }
      const clientVisible = s.clientVisible === true
        || (s.clientVisible === undefined && (s.photos || []).length > 0 && (s.status || 'Open') === 'Open');
      if ((s.status || 'Open') === 'Open' && clientVisible) openVisible++;
    }

    return {
      id: j.id,
      name: j.name,
      type: j.type || null,
      status: j.status || 'active',
      progress: { roughInPct, fitOffPct, overallPct, areasCount: areas.length },
      snags: { openVisible },
      lastActivityAt: lastActivityAt || null,
    };
  }));

  // Sort: active first, then most-recent activity first.
  rows.sort((a, b) => {
    const sa = a.status === 'active' ? 0 : 1;
    const sb = b.status === 'active' ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return (b.lastActivityAt || '').localeCompare(a.lastActivityAt || '');
  });

  return res.status(200).json({ count: rows.length, jobs: rows });
};
