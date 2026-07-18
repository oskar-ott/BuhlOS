// Pay-period reminder cron — pushes admins about pending hours, twice
// around the week boundary (product-owner directive 2026-07-18).
//
//   GET /api/payroll-reminder
//
// Walks per-user time-entries dated within the LAST TWO Sydney weeks
// (Monday of the previous week → today) and counts entries with
// status === 'submitted'. If any exist, fires a single push to every
// admin with at least one push subscription, with the count and oldest
// pending date. Silent when nothing is pending.
//
// Why two weeks, not the current week: the Monday-morning fire lands on
// day one of a NEW week — a current-week window would be one day wide
// and silent about exactly the entries the boss is chasing (last week's,
// about to be paid). The two-week window covers the closing week on the
// Sunday run and the just-closed week on the Monday run; anything still
// submitted from the previous week is a payroll problem either way.
//
// Why this is a standalone endpoint (not another action on
// /api/notifications):
//   The notifications file already carries several cron actions plus the
//   public-key / subscribe machinery; this shipped standalone so it could
//   land independently of the cron PRs then in flight (#68/#69/#83). The
//   duplicated helpers it originally carried are since shared: cron auth
//   comes from _lib/cron-auth (#381); only the two one-line Sydney date
//   helpers remain local.
//
// Wiring (#392, rescheduled by the 2026-07-18 directive): live in
// vercel.json crons[] as TWO entries (cron is UTC; both are Sunday-UTC):
//   { "path": "/api/payroll-reminder", "schedule": "0 8 * * 0"   }
//     = Sunday 18:00 AEST / 19:00 AEDT — clear the closing week tonight
//   { "path": "/api/payroll-reminder", "schedule": "30 21 * * 0" }
//     = Monday 07:30 AEST / 08:30 AEDT — before payroll gets run
//
// Body format:
//   "11.5h pending · oldest from Mon 11 May"
//   tap → /hours/approvals

const { list } = require('@vercel/blob');
const { readBlob, setNoCache } = require('./_lib/blob');
const { isFlagOn } = require('./_lib/feature-flags');
const { requireCron } = require('./_lib/cron-auth');
const { isPublicHoliday } = require('./_lib/public-holidays');
const { isAdminRole } = require('./_lib/auth');
const { getWebPush, sendPushToUserId } = require('./_lib/push');

const DAY_MS = 24 * 60 * 60 * 1000;
const USERS_KEY = 'users.json';

function sydneyToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Monday of the Sydney week containing 'today' (YYYY-MM-DD).
function sydneyMondayOf(today) {
  const wdShort = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Australia/Sydney', weekday: 'short',
  }).format(new Date(today + 'T00:00:00Z'));
  const map = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const wd = map[wdShort] ?? 0;
  return new Date(new Date(today + 'T00:00:00Z').getTime() - wd * DAY_MS)
    .toISOString().slice(0, 10);
}


// Light pretty-printer: "Mon 11 May" — matches the pattern admins use
// when chatting about which day's hours are stuck.
function prettyDate(yyyymmdd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyymmdd)) return yyyymmdd || '';
  const d = new Date(yyyymmdd + 'T00:00:00Z');
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    weekday: 'short', day: 'numeric', month: 'short',
  }).format(d);
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  if (!requireCron(req, res)) return;
  if (!getWebPush()) return res.status(503).json({ error: 'push not configured (missing VAPID env vars)' });

  const today    = sydneyToday();
  // #137: don't nag on a public holiday — nobody's logging hours, so the
  // reminder is just noise the office learns to swipe away.
  if (isPublicHoliday(today)) {
    return res.status(200).json({ ok: true, sent: 0, skipped: 'public holiday', date: today });
  }
  // If the owner ever kills the hours surface, a pending-hours push would be
  // a trace of a feature the app no longer shows. 200 (not an error) so the
  // cron reads as healthy; flips back on with the flag.
  if (!(await isFlagOn('hours'))) {
    return res.status(200).json({ ok: true, sent: 0, skipped: 'hours flag off' });
  }
  // Window = Monday of the PREVIOUS Sydney week → today (see header: the
  // Monday-morning fire must see the just-closed week, not a one-day window).
  const thisMonday = sydneyMondayOf(today);
  const windowStart = new Date(new Date(thisMonday + 'T00:00:00Z').getTime() - 7 * DAY_MS)
    .toISOString().slice(0, 10);
  const inWindow = (d) => d >= windowStart && d <= today;

  // Walk all per-user time-entries blobs for the week.
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  let entries = [];
  try {
    const r = await list({ prefix: 'users/', token, limit: 5000 });
    const blobs = (r.blobs || []).filter(b => {
      const m = b.pathname.match(/\/time-entries\/(\d{4}-\d{2}-\d{2})\.json$/);
      return m && inWindow(m[1]);
    });
    entries = (await Promise.all(blobs.map(async b => {
      try {
        const rr = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
        if (!rr.ok) return null;
        return await rr.json();
      } catch { return null; }
    }))).filter(Boolean);
  } catch (e) {
    console.error('payroll-reminder: blob walk failed', e);
  }

  const pending = entries.filter(e => e.status === 'submitted');

  const usersData = await readBlob(USERS_KEY, { users: [] });
  // No notificationPrefs gate, deliberately: docs/notifications.md classes
  // this push as owner-critical `alwaysOn` — muting the payroll nudge breaks
  // the approval loop, so there is no opt-out key for it.
  const admins = (usersData.users || []).filter(u =>
    isAdminRole(u.role) &&
    !u.archived &&
    Array.isArray(u.pushSubscriptions) && u.pushSubscriptions.length);

  if (!admins.length) {
    return res.status(200).json({ ok: true, sent: 0, skipped: 'no admin subscribers', pendingCount: pending.length });
  }
  if (!pending.length) {
    return res.status(200).json({ ok: true, sent: 0, skipped: 'no pending entries' });
  }

  // Find oldest pending entry by date.
  let oldestDate = today;
  for (const e of pending) {
    if (e.date && e.date < oldestDate) oldestDate = e.date;
  }
  const totalPendingHours = pending.reduce((s, e) => s + (Number(e.totalHours) || 0), 0);

  const title = pending.length === 1
    ? '1 hours entry awaiting approval'
    : `${pending.length} hours entries awaiting approval`;
  const body = `${totalPendingHours.toFixed(1)}h pending · oldest from ${prettyDate(oldestDate)}`;
  const payload = {
    title, body,
    url: '/hours/approvals',
    tag: 'buhl-payroll-reminder-' + today,
  };

  let sent = 0, pruned = 0;
  for (const u of admins) {
    const r = await sendPushToUserId(u.id, payload);
    sent   += (r.sent   || 0);
    pruned += (r.pruned || 0);
  }

  return res.status(200).json({
    ok: true, sent, pruned,
    pendingCount: pending.length,
    pendingHours: Math.round(totalPendingHours * 10) / 10,
    oldestDate,
    windowStart, today,
  });
};
