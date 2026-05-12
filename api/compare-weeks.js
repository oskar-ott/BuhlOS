// Week-over-week comparison.
//
//   GET /api/compare-weeks
//       ?weekStart=YYYY-MM-DD     (default: current week's Monday, Sydney)
//
// Returns this-week vs last-week (= weekStart's previous Mon..Sun) side-by-side
// with absolute deltas and % change. Same metrics as /api/weekly-report (#70),
// but doubled up and diffed — for the dashboard "are we trending up or down?"
// strip.
//
// Response shape:
//   {
//     thisWeek:  { weekStart, weekEnd, hours, snags, newJobs },
//     lastWeek:  { weekStart, weekEnd, hours, snags, newJobs },
//     deltas: {
//       hoursApprovedTotal:  { abs, pct },
//       hoursSubmittedTotal: { abs, pct },
//       snagsOpened:         { abs, pct },
//       snagsResolved:       { abs, pct },
//       newJobs:             { abs, pct }
//     }
//   }
//
// % change: (new - old) / old.  When old is 0:
//   - new is also 0 → pct: 0
//   - new is > 0    → pct: null (infinite; caller renders "new this week")
//
// Permissions:
//   - admin: all jobs / all users
//   - leadingHand: scoped to assignedJobIds
//   - everyone else: 403

const { list } = require('@vercel/blob');
const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

const DAY_MS = 24 * 60 * 60 * 1000;

function sydneyToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

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

function pctChange(now, prev) {
  if (prev === 0) return now === 0 ? 0 : null;
  return Math.round(((now - prev) / prev) * 1000) / 1000;
}

// Aggregate one week's hours + snags + new-jobs for the given visible job set.
async function weekRollup(weekStart, weekEnd, visible, visibleIds, isAdmin, token) {
  const inWindow = (yyyymmdd) => yyyymmdd >= weekStart && yyyymmdd <= weekEnd;
  const jobNameById = {};
  for (const j of visible) jobNameById[j.id] = j.name;

  // Hours.
  let hoursBlobs = [];
  try {
    const r = await list({ prefix: 'users/', token, limit: 5000 });
    hoursBlobs = (r.blobs || []).filter(b => {
      const m = b.pathname.match(/\/time-entries\/(\d{4}-\d{2}-\d{2})\.json$/);
      return m && inWindow(m[1]);
    });
  } catch { /* swallow */ }

  const hours = {
    submittedCount: 0, submittedTotal: 0,
    approvedCount:  0, approvedTotal:  0,
  };
  await Promise.all(hoursBlobs.map(async b => {
    let entry;
    try {
      const r = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      entry = await r.json();
    } catch { return; }
    if (!entry) return;
    const allocs = (entry.allocations || []).filter(a =>
      isAdmin || (a.jobId && visibleIds.has(a.jobId)));
    if (!allocs.length) return;
    const total = allocs.reduce((s, a) => s + (Number(a.hours) || 0), 0);
    if (total <= 0) return;
    if (entry.status === 'submitted') {
      hours.submittedCount++;
      hours.submittedTotal += total;
    } else if (entry.status === 'approved') {
      hours.approvedCount++;
      hours.approvedTotal += total;
    }
  }));
  hours.submittedTotal = Math.round(hours.submittedTotal * 10) / 10;
  hours.approvedTotal  = Math.round(hours.approvedTotal  * 10) / 10;

  // Snags.
  let opened = 0, resolved = 0;
  await Promise.all(visible.map(async j => {
    let data;
    try { data = await readBlob(`jobs/${j.id}/data.json`, { snags: [] }); }
    catch { return; }
    for (const s of (data.snags || [])) {
      const created = (s.createdAt || s.date || '').slice(0, 10);
      const closed  = (s.closedAt  || '').slice(0, 10);
      if (created && inWindow(created)) opened++;
      if (closed  && inWindow(closed))  resolved++;
    }
  }));

  // New jobs (within window).
  const newJobs = visible.filter(j => {
    const c = (j.createdAt || '').slice(0, 10);
    return c && inWindow(c);
  }).length;

  return {
    weekStart, weekEnd,
    hours, snags: { opened, resolved }, newJobs,
  };
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

  let thisWeekStart = (req.query && req.query.weekStart) || sydneyMondayOf(sydneyToday());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(thisWeekStart)) {
    return res.status(400).json({ error: 'weekStart must be YYYY-MM-DD' });
  }
  const thisWeekEnd  = addDaysISO(thisWeekStart, 6);
  const lastWeekStart = addDaysISO(thisWeekStart, -7);
  const lastWeekEnd   = addDaysISO(thisWeekStart, -1);

  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const allJobs  = jobsBlob.jobs || [];
  const visible = (me.role === 'admin')
    ? allJobs
    : allJobs.filter(j => (me.assignedJobIds || []).includes(j.id));
  const visibleIds = new Set(visible.map(j => j.id));
  const isAdmin = me.role === 'admin';
  const token = process.env.BLOB_READ_WRITE_TOKEN;

  const [thisWeek, lastWeek] = await Promise.all([
    weekRollup(thisWeekStart, thisWeekEnd, visible, visibleIds, isAdmin, token),
    weekRollup(lastWeekStart, lastWeekEnd, visible, visibleIds, isAdmin, token),
  ]);

  const deltas = {
    hoursApprovedTotal: {
      abs: Math.round((thisWeek.hours.approvedTotal - lastWeek.hours.approvedTotal) * 10) / 10,
      pct: pctChange(thisWeek.hours.approvedTotal, lastWeek.hours.approvedTotal),
    },
    hoursSubmittedTotal: {
      abs: Math.round((thisWeek.hours.submittedTotal - lastWeek.hours.submittedTotal) * 10) / 10,
      pct: pctChange(thisWeek.hours.submittedTotal, lastWeek.hours.submittedTotal),
    },
    snagsOpened: {
      abs: thisWeek.snags.opened - lastWeek.snags.opened,
      pct: pctChange(thisWeek.snags.opened, lastWeek.snags.opened),
    },
    snagsResolved: {
      abs: thisWeek.snags.resolved - lastWeek.snags.resolved,
      pct: pctChange(thisWeek.snags.resolved, lastWeek.snags.resolved),
    },
    newJobs: {
      abs: thisWeek.newJobs - lastWeek.newJobs,
      pct: pctChange(thisWeek.newJobs, lastWeek.newJobs),
    },
  };

  return res.status(200).json({ thisWeek, lastWeek, deltas });
};
