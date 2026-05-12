// Client-facing weekly update endpoint.
//
//   GET /api/client-update?jobId=<id>
//
// Returns a sanitised "what happened on your site this week" summary
// for the client portal. Stripped of internal-only details — no hours,
// no costs, no assignee names, no internal notes. The shape is tuned
// for a single section on /client.html: progress, snag movement, last
// activity.
//
// Response:
//   {
//     jobId, jobName, jobType,
//     weekStart, weekEnd,
//     progress: { roughInPct, fitOffPct, overallPct, areasCount },
//     snags: {
//       raisedThisWeek,    // count only, descriptions not exposed
//       resolvedThisWeek,
//       openVisible        // current open snags marked client-visible
//     },
//     lastActivityAt
//   }
//
// Permissions:
//   - client: only their own job (clientUserId === me.id)
//   - admin / leadingHand on this job: yes (for preview / debugging the
//     view the client will see — same data, no extras)
//   - everyone else: 403
//
// Why this exists:
//   The client portal currently fetches /api/data and computes progress
//   client-side. A dedicated summary endpoint (a) decides server-side
//   what's safe to expose (clientVisible filtering), (b) carries the
//   same numbers a future Friday-evening client email or PDF report
//   would consume, and (c) keeps the portal's bundle small.
//
// Progress math mirrors the per-area effective-task averaging that
// client.html already does (per-area roughInTasks/fitOffTasks override
// the job-level defaults).

const { readBlob, setNoCache } = require('./_lib/blob');
const { getCurrentUser, canManageJob } = require('./_lib/auth');

const DAY_MS = 24 * 60 * 60 * 1000;

// Monday of Sydney week containing 'today' (YYYY-MM-DD).
function sydneyMondayOf(today) {
  const wdShort = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Australia/Sydney', weekday: 'short',
  }).format(new Date(today + 'T00:00:00Z'));
  const map = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const wd = map[wdShort] ?? 0;
  return new Date(new Date(today + 'T00:00:00Z').getTime() - wd * DAY_MS)
    .toISOString().slice(0, 10);
}

function sydneyToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'not authenticated' });

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const job = (jobsBlob.jobs || []).find(j => j.id === jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  // Permission: client must own this job, admin/LH must manage it.
  const ok = (me.role === 'client' && job.clientUserId === me.id)
          || canManageJob(me, jobId);
  if (!ok) return res.status(403).json({ error: 'forbidden' });

  const today      = sydneyToday();
  const weekStart  = sydneyMondayOf(today);
  const weekEnd    = new Date(new Date(weekStart + 'T00:00:00Z').getTime() + 6 * DAY_MS)
                     .toISOString().slice(0, 10);
  const inWindow = (yyyymmdd) => yyyymmdd >= weekStart && yyyymmdd <= weekEnd;

  // ── Progress (mirrors client.html math) ───────────────────────────────
  const data = await readBlob(`jobs/${jobId}/data.json`, { dwellings: {}, snags: [] });
  const areas = (job.areaGroups || []).flatMap(g => g.areas || []);
  const dwellings = data.dwellings || {};
  const jobRt = job.roughInTasks || [];
  const jobFt = job.fitOffTasks  || [];
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
  const roughPct = rCount ? Math.round(rSum / rCount * 100) : 0;
  const fitPct   = fCount ? Math.round(fSum / fCount * 100) : 0;
  const overallPct = (rCount || fCount)
    ? Math.round((rCount && fCount) ? (roughPct + fitPct) / 2 : (rCount ? roughPct : fitPct))
    : 0;

  // ── Snags this week ───────────────────────────────────────────────────
  let raisedThisWeek = 0;
  let resolvedThisWeek = 0;
  let openVisible = 0;
  let lastActivityAt = '';

  for (const s of (data.snags || [])) {
    const created = (s.createdAt || s.date || '').slice(0, 10);
    const closed  = (s.closedAt  || '').slice(0, 10);
    // Update lastActivityAt — pick the latest of createdAt / closedAt / updatedAt
    for (const ts of [s.createdAt, s.closedAt, s.updatedAt]) {
      if (ts && ts > lastActivityAt) lastActivityAt = ts;
    }
    // Raised: only count client-visible snags so the number matches what
    // the client can see in their portal.
    const clientVisible = s.clientVisible === true
      || (s.clientVisible === undefined && (s.photos || []).length > 0 && (s.status || 'Open') === 'Open');
    if (created && inWindow(created) && clientVisible) raisedThisWeek++;
    // Resolved: count any client-visible snag that closed this week.
    if (closed && inWindow(closed) && (clientVisible || s.clientVisible === true)) resolvedThisWeek++;
    // Open visible right now.
    if ((s.status || 'Open') === 'Open' && clientVisible) openVisible++;
  }

  return res.status(200).json({
    jobId, jobName: job.name, jobType: job.type || null,
    weekStart, weekEnd,
    progress: {
      roughInPct: roughPct,
      fitOffPct:  fitPct,
      overallPct,
      areasCount: areas.length,
    },
    snags: {
      raisedThisWeek,
      resolvedThisWeek,
      openVisible,
    },
    lastActivityAt: lastActivityAt || null,
  });
};
