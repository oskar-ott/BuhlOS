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
// The aggregation itself lives in api/_lib/day-pulse.js (#170) so the AI
// assistant's `company_day_pulse` tool serves the SAME numbers — one engine,
// two consumers. Cost shape unchanged: 1 jobs.json read + 1 blob list on
// users/ + N parallel per-active-job data.json reads.

const { setNoCache } = require('./_lib/blob');
const { requireAuth, isStaffRole } = require('./_lib/auth');
const { computeDayPulse, sydneyToday } = require('./_lib/day-pulse');

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

  const pulse = await computeDayPulse(me, date);
  return res.status(200).json(pulse);
};
