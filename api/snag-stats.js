// Snag trend & profile stats.
//
//   GET /api/snag-stats?jobId=<id>&weeks=4
//
// Returns per-job (or cross-job if jobId omitted) snag stats: current
// open/closed counts by priority, recent open-vs-resolve trend per week,
// and a mean days-to-close on snags that closed within the window.
//
// jobId omitted → aggregate across every visible active job (admin = all,
// LH = assignedJobIds). Useful for a "snag health" widget on the
// operations dashboard.
//
// Response:
//   {
//     scope: 'job' | 'cross',
//     jobId?, jobName?,
//     weeksWindow,
//     open:   { total, byPriority: { High, Medium, Low } },
//     closed: { total, byPriority: { ... }, meanDaysToClose, withinWindow },
//     trend:  [{ weekStart, opened, resolved }]   // weeksWindow rows
//   }
//
// Trend rows are Mon→Sun (Sydney calendar) buckets, oldest first. The
// `weekStart` is the Monday of the bucket.
//
// Permissions:
//   - admin
//   - leadingHand (single-job mode requires job in assigned list; cross
//     mode aggregates across assigned jobs only)
//   - everyone else: 403

const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canManageJob } = require('./_lib/auth');

const DAY_MS = 24 * 60 * 60 * 1000;
const PRIORITIES = ['High', 'Medium', 'Low'];

function sydneyToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Monday of the Sydney-calendar week containing `today` (YYYY-MM-DD).
function sydneyMondayOf(today) {
  const wdShort = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Australia/Sydney', weekday: 'short',
  }).format(new Date(today + 'T00:00:00Z'));
  const map = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const wd = map[wdShort] ?? 0;
  return new Date(new Date(today + 'T00:00:00Z').getTime() - wd * DAY_MS)
    .toISOString().slice(0, 10);
}

function addDaysISO(yyyymmdd, n) {
  return new Date(new Date(yyyymmdd + 'T00:00:00Z').getTime() + n * DAY_MS)
    .toISOString().slice(0, 10);
}

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
  let weeks = parseInt(q.weeks, 10);
  if (!Number.isFinite(weeks) || weeks < 1) weeks = 4;
  if (weeks > 26) weeks = 26;

  // Resolve which jobs to walk.
  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const allJobs  = jobsBlob.jobs || [];
  let walkJobs;
  let scope, jobName;
  if (jobIdQ) {
    const job = allJobs.find(j => j.id === jobIdQ);
    if (!job) return res.status(404).json({ error: 'job not found' });
    if (!canManageJob(me, jobIdQ)) return res.status(403).json({ error: 'no access to job' });
    walkJobs = [job];
    scope = 'job';
    jobName = job.name;
  } else {
    const active = allJobs.filter(j => (j.status || 'active') === 'active');
    walkJobs = me.role === 'admin'
      ? active
      : active.filter(j => (me.assignedJobIds || []).includes(j.id));
    scope = 'cross';
  }

  // Build the week buckets, oldest first.
  const today      = sydneyToday();
  const currentMon = sydneyMondayOf(today);
  const buckets = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = addDaysISO(currentMon, -7 * i);
    const end   = addDaysISO(start, 6);
    buckets.push({ weekStart: start, weekEnd: end, opened: 0, resolved: 0 });
  }
  const earliest = buckets[0] ? buckets[0].weekStart : currentMon;
  const latest   = buckets[buckets.length - 1] ? buckets[buckets.length - 1].weekEnd : currentMon;

  // Accumulators.
  const open   = { total: 0, byPriority: { High: 0, Medium: 0, Low: 0 } };
  const closed = { total: 0, byPriority: { High: 0, Medium: 0, Low: 0 } };
  let closeDaysSum = 0, closedWithinWindow = 0;

  await Promise.all(walkJobs.map(async j => {
    let data;
    try { data = await readBlob(`jobs/${j.id}/data.json`, { snags: [] }); }
    catch { return; }
    for (const s of (data.snags || [])) {
      const status = s.status || 'Open';
      const prio   = PRIORITIES.includes(s.priority) ? s.priority : 'Medium';
      if (status === 'Open') {
        open.total++; open.byPriority[prio]++;
      } else if (status === 'Closed') {
        closed.total++; closed.byPriority[prio]++;
      }

      // Trend bucketing — only count events within the window.
      const created = (s.createdAt || s.date || '').slice(0, 10);
      const closedDay = (s.closedAt || '').slice(0, 10);
      if (created && created >= earliest && created <= latest) {
        const b = buckets.find(bk => created >= bk.weekStart && created <= bk.weekEnd);
        if (b) b.opened++;
      }
      if (closedDay && closedDay >= earliest && closedDay <= latest) {
        const b = buckets.find(bk => closedDay >= bk.weekStart && closedDay <= bk.weekEnd);
        if (b) b.resolved++;
      }

      // Days-to-close for snags closed within window with both timestamps.
      if (status === 'Closed' && created && closedDay
          && closedDay >= earliest && closedDay <= latest) {
        const ct = Date.parse(created + 'T00:00:00Z');
        const xt = Date.parse(closedDay + 'T00:00:00Z');
        if (Number.isFinite(ct) && Number.isFinite(xt) && xt >= ct) {
          closeDaysSum += (xt - ct) / DAY_MS;
          closedWithinWindow++;
        }
      }
    }
  }));

  const meanDaysToClose = closedWithinWindow > 0
    ? Math.round((closeDaysSum / closedWithinWindow) * 10) / 10
    : null;

  const out = {
    scope,
    weeksWindow: weeks,
    open,
    closed: {
      ...closed,
      meanDaysToClose,
      withinWindow: closedWithinWindow,
    },
    trend: buckets.map(b => ({
      weekStart: b.weekStart, weekEnd: b.weekEnd,
      opened: b.opened, resolved: b.resolved,
    })),
  };
  if (scope === 'job') {
    out.jobId   = jobIdQ;
    out.jobName = jobName;
  } else {
    out.jobsInScope = walkJobs.length;
  }
  return res.status(200).json(out);
};
