// Crew utilization — per-tradie hours-vs-expected for a week.
//
//   GET /api/crew-utilization?weekStart=YYYY-MM-DD&expectedHours=40
//
// For each active tradie / LH: hours logged this week (split by status),
// utilization % vs an expected weekly target (default 40h), over/under
// in hours, and an estimated value at their hourly rate.
//
// Why this exists:
//   Daniel wants to know who's overworked, who's under-booked, and what
//   the projected weekly payroll cost is before the Friday cutoff. The
//   numbers exist in time-entries + users.json but require a fan-out
//   walk + role-aware aggregation; doing it server-side gives one
//   snappy fetch for the dashboard widget.
//
// Response:
//   {
//     weekStart, weekEnd, expectedHours,
//     crew: [{
//       userId, username, role,
//       hoursLogged: { submitted, approved, draft, total },
//       utilizationPct,           // total / expectedHours (rounded 1dp)
//       overUnder,                // total - expectedHours
//       hourlyRateExGst,          // (admin's eye only — see permissions)
//       estimatedValueExGst       // total × rate
//     }],
//     totals: { totalHours, totalValueExGst, expectedTotalHours }
//   }
//
// Sort: total hours desc, then username.
//
// Permissions: admin only. The endpoint exposes hourly rates and a
// dollar estimate of every crew member's week — same sensitivity as
// the payroll CSV (#71 / time-entries-export).

const { list } = require('@vercel/blob');
const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');

const DAY_MS = 24 * 60 * 60 * 1000;
const STAFF_ROLES = new Set(['admin', 'leadingHand', 'tradie']);
const DEFAULT_EXPECTED = 40;

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

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res, { roles: ['admin'] });
  if (!me) return;

  const q = req.query || {};
  const today = sydneyToday();
  const weekStart = q.weekStart || sydneyMondayOf(today);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return res.status(400).json({ error: 'weekStart must be YYYY-MM-DD' });
  }
  const weekEnd = addDaysISO(weekStart, 6);

  let expectedHours = parseFloat(q.expectedHours);
  if (!Number.isFinite(expectedHours) || expectedHours <= 0) expectedHours = DEFAULT_EXPECTED;
  if (expectedHours > 168) expectedHours = 168; // sanity cap

  // Reference users (staff only, non-archived).
  const usersBlob = await readBlob('users.json', { users: [] });
  const staff = (usersBlob.users || []).filter(u => STAFF_ROLES.has(u.role) && !u.archived);
  const staffIds = new Set(staff.map(u => u.id));

  // Walk this week's per-user time-entries.
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  let entries = [];
  try {
    const r = await list({ prefix: 'users/', token, limit: 5000 });
    const candidates = (r.blobs || []).filter(b => {
      const m = b.pathname.match(/^users\/([^/]+)\/time-entries\/(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) return false;
      if (m[2] < weekStart || m[2] > weekEnd) return false;
      return staffIds.has(m[1]);
    });
    entries = (await Promise.all(candidates.map(async b => {
      try {
        const rr = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!rr.ok) return null;
        return await rr.json();
      } catch { return null; }
    }))).filter(Boolean);
  } catch (e) { console.error('crew-utilization: walk failed', e); }

  // Per-user accumulator.
  const byUser = {};
  for (const u of staff) {
    byUser[u.id] = {
      userId: u.id,
      username: u.username,
      role: u.role,
      hoursLogged: { submitted: 0, approved: 0, draft: 0, total: 0 },
      utilizationPct: 0,
      overUnder: -expectedHours,
      hourlyRateExGst: typeof u.hourlyRate === 'number' ? u.hourlyRate : 0,
      estimatedValueExGst: 0,
    };
  }

  for (const e of entries) {
    const u = byUser[e.userId];
    if (!u) continue;
    const total = Number(e.totalHours) || 0;
    if (total <= 0) continue;
    u.hoursLogged.total += total;
    if (e.status === 'submitted') u.hoursLogged.submitted += total;
    else if (e.status === 'approved') u.hoursLogged.approved += total;
    else if (e.status === 'draft')    u.hoursLogged.draft    += total;
    // (rejected entries don't count toward utilization)
  }

  // Finalise per-user.
  let totalHours = 0;
  let totalValueExGst = 0;
  const crew = Object.values(byUser);
  for (const c of crew) {
    c.hoursLogged.total      = Math.round(c.hoursLogged.total      * 10) / 10;
    c.hoursLogged.submitted  = Math.round(c.hoursLogged.submitted  * 10) / 10;
    c.hoursLogged.approved   = Math.round(c.hoursLogged.approved   * 10) / 10;
    c.hoursLogged.draft      = Math.round(c.hoursLogged.draft      * 10) / 10;
    c.utilizationPct       = Math.round((c.hoursLogged.total / expectedHours) * 1000) / 10; // % to 1dp
    c.overUnder            = Math.round((c.hoursLogged.total - expectedHours) * 10) / 10;
    c.estimatedValueExGst  = Math.round(c.hoursLogged.total * c.hourlyRateExGst * 100) / 100;
    totalHours += c.hoursLogged.total;
    totalValueExGst += c.estimatedValueExGst;
  }
  crew.sort((a, b) => {
    if (b.hoursLogged.total !== a.hoursLogged.total) return b.hoursLogged.total - a.hoursLogged.total;
    return (a.username || '').localeCompare(b.username || '');
  });

  return res.status(200).json({
    weekStart, weekEnd, expectedHours,
    crew,
    totals: {
      totalHours: Math.round(totalHours * 10) / 10,
      totalValueExGst: Math.round(totalValueExGst * 100) / 100,
      expectedTotalHours: Math.round(crew.length * expectedHours * 10) / 10,
    },
  });
};
