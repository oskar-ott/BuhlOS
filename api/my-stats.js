// Tradie-facing personal stats endpoint.
//
//   GET /api/my-stats
//
// Returns a quick roll-up of the current user's hours activity, suitable
// for a "this week" badge on /my-day or the mobile job-stats widget. The
// front-end can compute this from /api/time-entries, but rolling it up
// server-side keeps the mobile bundle slim and means the same numbers
// power any future surface (stats screen, weekly email, push body).
//
// Response shape:
//   {
//     userId, username,
//     today:     { totalHours, status }            // null if no entry today
//     thisWeek:  { totalHours, approvedHours, pendingHours,
//                  daysWithEntries, topJobs: [...] },
//     thisMonth: { totalHours, approvedHours }
//   }
//
// All hours rounded to one decimal. Week = Mon→Sun in Sydney. Month =
// calendar month of today's Sydney date.
//
// Permissions:
//   - Any authenticated user can read their own stats.
//   - Clients still allowed (their reply: 0 hours everywhere), keeps the
//     endpoint role-agnostic so a unified "me" header can hit it without
//     branching.

const { list } = require('@vercel/blob');
const { readBlob, setNoCache } = require('./_lib/blob');
const { getCurrentUser } = require('./_lib/auth');

const DAY_MS = 24 * 60 * 60 * 1000;

// Today's date in Sydney (YYYY-MM-DD). Hours entries are stored as YYYY-MM-DD,
// so we match against the tradie's calendar day, not UTC.
function sydneyToday() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
}

// Monday of the Sydney-calendar week containing `today` (YYYY-MM-DD).
function sydneyMondayOf(today) {
  // Build a Date for that calendar day at UTC midnight, then back out the day
  // of week. We need the Sydney-local weekday, which we read via Intl.
  const wdShort = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Australia/Sydney', weekday: 'short',
  }).format(new Date(today + 'T00:00:00Z'));
  // Map: Mon=0 ... Sun=6
  const wdMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const wd = wdMap[wdShort] ?? 0;
  const t = new Date(today + 'T00:00:00Z').getTime() - wd * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'not authenticated' });

  const today    = sydneyToday();
  const weekStart = sydneyMondayOf(today);
  const monthStart = today.slice(0, 7) + '-01';

  // Walk this user's time-entries blobs by direct prefix — single list call.
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  let entries = [];
  try {
    const r = await list({ prefix: `users/${me.id}/time-entries/`, token, limit: 1000 });
    const blobs = (r.blobs || []).filter(b =>
      /\/time-entries\/\d{4}-\d{2}-\d{2}\.json$/.test(b.pathname));
    entries = (await Promise.all(blobs.map(async b => {
      try {
        const rr = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!rr.ok) return null;
        return await rr.json();
      } catch { return null; }
    }))).filter(Boolean);
  } catch (e) {
    console.error('my-stats: blob list failed', e);
  }

  // Tag each entry with its date (some old writes may have missed `date`).
  for (const e of entries) {
    if (!e.date && typeof e.id === 'string') {
      // Fallback: id often encodes the date for newer entries.
      const m = e.id.match(/^(\d{4}-\d{2}-\d{2})/);
      if (m) e.date = m[1];
    }
  }

  // Today.
  const todayEntry = entries.find(e => e.date === today);
  const todayOut = todayEntry ? {
    totalHours: Math.round((Number(todayEntry.totalHours) || 0) * 10) / 10,
    status: todayEntry.status || 'draft',
  } : null;

  // This week (Mon→Sun, inclusive).
  const weekEnd = new Date(new Date(weekStart + 'T00:00:00Z').getTime() + 6 * DAY_MS)
    .toISOString().slice(0, 10);
  const inWeek = entries.filter(e =>
    e.date && e.date >= weekStart && e.date <= weekEnd);

  let weekTotal = 0, weekApproved = 0, weekPending = 0;
  const weekDays = new Set();
  const weekByJob = {}; // jobId → hours
  for (const e of inWeek) {
    const total = Number(e.totalHours) || 0;
    if (total <= 0) continue;
    weekTotal += total;
    if (e.status === 'approved') weekApproved += total;
    if (e.status === 'submitted') weekPending += total;
    if (e.date) weekDays.add(e.date);
    for (const a of (e.allocations || [])) {
      if (!a.jobId) continue;
      weekByJob[a.jobId] = (weekByJob[a.jobId] || 0) + (Number(a.hours) || 0);
    }
  }

  // Resolve job names for top jobs.
  let jobNameById = {};
  const usedJobIds = Object.keys(weekByJob);
  if (usedJobIds.length) {
    try {
      const jobsBlob = await readBlob('jobs.json', { jobs: [] });
      for (const j of (jobsBlob.jobs || [])) jobNameById[j.id] = j.name;
    } catch { /* names just fall back to ids */ }
  }
  const topJobs = Object.entries(weekByJob)
    .map(([jobId, h]) => ({
      jobId,
      jobName: jobNameById[jobId] || jobId,
      hours: Math.round(h * 10) / 10,
    }))
    .sort((a, b) => b.hours - a.hours)
    .slice(0, 5);

  // This month.
  const inMonth = entries.filter(e =>
    e.date && e.date >= monthStart && e.date <= today);
  let monthTotal = 0, monthApproved = 0;
  for (const e of inMonth) {
    const total = Number(e.totalHours) || 0;
    if (total <= 0) continue;
    monthTotal += total;
    if (e.status === 'approved') monthApproved += total;
  }

  return res.status(200).json({
    userId: me.id, username: me.username,
    today: todayOut,
    thisWeek: {
      weekStart, weekEnd,
      totalHours:    Math.round(weekTotal * 10) / 10,
      approvedHours: Math.round(weekApproved * 10) / 10,
      pendingHours:  Math.round(weekPending * 10) / 10,
      daysWithEntries: weekDays.size,
      topJobs,
    },
    thisMonth: {
      monthStart,
      totalHours:    Math.round(monthTotal * 10) / 10,
      approvedHours: Math.round(monthApproved * 10) / 10,
    },
  });
};
