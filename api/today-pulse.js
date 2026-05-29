// Live "what's happening on site today" snapshot for admin / LH.
//
//   GET /api/today-pulse?date=YYYY-MM-DD
//
// Same numbers the end-of-day digest cron composes (#68), but on-demand
// and at any point in the day. Designed for the operations dashboard
// widget that refreshes every few minutes; admins want to see the day
// take shape, not just learn about it at 5pm.
//
// Date defaults to today (Sydney). Past dates are allowed — admins can
// scroll back through quiet days or busy ones for context.
//
// Response shape:
//   {
//     date,
//     hours: {
//       submittedCount, submittedTotal,
//       approvedCount,  approvedTotal,
//       pendingCount, draftCount,
//       crewOnSite        // distinct users with >0 hours on the day
//     },
//     snags:  { openedToday, resolvedToday },
//     jobs:   { activeJobs, jobsWithActivityToday }
//   }
//
// Permissions:
//   - admin: all
//   - leadingHand: hours / snags / jobs restricted to assigned jobs
//   - everyone else: 403
//
// Cost: 1 jobs.json read + 1 blob list on users/ + N parallel
// per-active-job data.json reads. Same cost shape as the digest cron.

const { list } = require('@vercel/blob');
const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isStaffRole } = require('./_lib/auth');

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

  const me = await requireAuth(req, res);
  if (!me) return;
  if (!isStaffRole(me.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const date = (req.query && req.query.date) || sydneyToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  // Resolve which jobs this user can see (LH gets a subset).
  const jobsBlob = await readBlob('jobs.json', { jobs: [] });
  const allJobs  = jobsBlob.jobs || [];
  const active   = allJobs.filter(j => (j.status || 'active') === 'active');
  const visible  = (me.role === 'admin')
    ? active
    : active.filter(j => (me.assignedJobIds || []).includes(j.id));
  const visibleIds = new Set(visible.map(j => j.id));

  // ── Hours: walk per-user time-entries for the date ────────────────────
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  let hours = {
    submittedCount: 0, submittedTotal: 0,
    approvedCount:  0, approvedTotal:  0,
    pendingCount:   0, draftCount:     0,
    crewOnSite:     0,
  };
  const crewSet = new Set();
  const jobsWithHoursToday = new Set();

  try {
    const r = await list({ prefix: 'users/', token, limit: 5000 });
    const blobs = (r.blobs || []).filter(b =>
      b.pathname.endsWith(`/time-entries/${date}.json`));

    const entries = (await Promise.all(blobs.map(async b => {
      try {
        const rr = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!rr.ok) return null;
        return await rr.json();
      } catch { return null; }
    }))).filter(Boolean);

    for (const e of entries) {
      // LH-visibility filter on allocations.
      const allocs = (e.allocations || []).filter(a =>
        me.role === 'admin' || (a.jobId && visibleIds.has(a.jobId)));
      if (!allocs.length) continue;

      const allocHours = allocs.reduce((s, a) => s + (Number(a.hours) || 0), 0);
      if (allocHours <= 0) continue;

      if (e.status === 'submitted') {
        hours.submittedCount++;
        hours.submittedTotal += allocHours;
        hours.pendingCount++;
      } else if (e.status === 'approved') {
        hours.approvedCount++;
        hours.approvedTotal += allocHours;
      } else if (e.status === 'draft') {
        hours.draftCount++;
      }
      if (e.userId) crewSet.add(e.userId);
      for (const a of allocs) if (a.jobId) jobsWithHoursToday.add(a.jobId);
    }
  } catch (err) { console.error('today-pulse: hours walk failed', err); }

  hours.crewOnSite      = crewSet.size;
  hours.submittedTotal  = Math.round(hours.submittedTotal * 10) / 10;
  hours.approvedTotal   = Math.round(hours.approvedTotal  * 10) / 10;

  // ── Snags: per active job, count opened / resolved on `date` ──────────
  let openedToday = 0;
  let resolvedToday = 0;
  const jobsWithSnagsToday = new Set();

  await Promise.all(visible.map(async j => {
    let data;
    try { data = await readBlob(`jobs/${j.id}/data.json`, { snags: [] }); }
    catch { return; }
    let any = false;
    for (const s of (data.snags || [])) {
      const created = (s.createdAt || s.date || '').slice(0, 10);
      const closed  = (s.closedAt  || '').slice(0, 10);
      if (created === date) { openedToday++; any = true; }
      if (closed  === date) { resolvedToday++; any = true; }
    }
    if (any) jobsWithSnagsToday.add(j.id);
  }));

  const jobsWithActivityToday = new Set([
    ...jobsWithHoursToday, ...jobsWithSnagsToday,
  ]).size;

  return res.status(200).json({
    date,
    hours,
    snags: { openedToday, resolvedToday },
    jobs: {
      activeJobs: visible.length,
      jobsWithActivityToday,
    },
  });
};
