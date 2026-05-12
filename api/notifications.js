// Web Push notifications for the /my-day "don't forget to log your hours" nudge.
//
// Three actions, all on the same endpoint:
//
//   GET  /api/notifications?action=public-key
//        Returns { publicKey } — the VAPID public key. Frontend needs this
//        before subscribing. Reading from env keeps the key out of the repo
//        and out of client-side JS.
//
//   POST /api/notifications?action=subscribe      (authenticated)
//        Body: a PushSubscription JSON blob from pushManager.subscribe().
//        Stores it on the current user (dedup by endpoint). Max 5 endpoints
//        per user — tradies juggle phones, but we don't want unbounded growth.
//
//   GET  /api/notifications?action=send-daily-reminders
//        Cron-only endpoint (scheduled in vercel.json at 16:30 Sydney on
//        weekdays). Finds tradies who haven't logged hours for today across
//        any assigned job, and sends a push to each of their subscriptions.
//        Expired subscriptions (410 Gone) are pruned.
//
// Env vars required:
//   VAPID_PUBLIC_KEY   — public key (exposed to frontend via public-key action)
//   VAPID_PRIVATE_KEY  — private key (server-side only)
//   VAPID_SUBJECT      — optional, defaults to 'mailto:admin@buhl.local'
//   CRON_SECRET        — optional shared secret. If set, send-daily-reminders
//                        requires header 'x-cron-secret' to match. Vercel Cron
//                        automatically sends 'authorization: Bearer <CRON_SECRET>'
//                        which we also accept.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { getCurrentUser } = require('./_lib/auth');
const { getWebPush, sendPushToUserId } = require('./_lib/push');

const USERS_KEY = 'users.json';
const MAX_SUBS_PER_USER = 5;

// Today's date in Sydney (YYYY-MM-DD). Hours entries are stored as YYYY-MM-DD,
// and "today" for the purpose of "did they log hours" must match the tradie's
// calendar day, not UTC.
function sydneyToday() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date()); // en-CA -> YYYY-MM-DD
}

// Sources from the new time-entries system (single per-user blob per day).
// One blob read per user — much cheaper than the legacy fan-out across jobs.
async function userHasLoggedHoursToday(user, today) {
  const entry = await readBlob(`users/${user.id}/time-entries/${today}.json`, null);
  return !!(entry && Number(entry.totalHours) > 0);
}

// Does the incoming cron request carry a valid secret? If no secret is
// configured, we allow the call (useful in preview envs). Vercel Cron sends
// `authorization: Bearer <CRON_SECRET>` automatically when CRON_SECRET is set.
function cronAuthorised(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true;
  const hdr = req.headers['authorization'] || '';
  if (hdr === `Bearer ${expected}`) return true;
  if ((req.headers['x-cron-secret'] || '') === expected) return true;
  return false;
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = (req.query && req.query.action) || '';

  // ── public-key: unauthenticated, needed before subscribe ───────────────
  if (action === 'public-key' && req.method === 'GET') {
    const pub = process.env.VAPID_PUBLIC_KEY || '';
    if (!pub) return res.status(503).json({ error: 'push not configured' });
    return res.status(200).json({ publicKey: pub });
  }

  // ── subscribe: save the current user's PushSubscription ────────────────
  if (action === 'subscribe' && req.method === 'POST') {
    const me = await getCurrentUser(req);
    if (!me) return res.status(401).json({ error: 'not authenticated' });

    const sub = req.body || {};
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return res.status(400).json({ error: 'invalid subscription' });
    }

    const data = await readBlob(USERS_KEY, { users: [] });
    const u = (data.users || []).find(x => x.id === me.id);
    if (!u) return res.status(404).json({ error: 'user not found' });

    u.pushSubscriptions = (u.pushSubscriptions || []).filter(s => s.endpoint !== sub.endpoint);
    u.pushSubscriptions.push({
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      createdAt: new Date().toISOString(),
    });
    // Cap per-user (keep newest)
    if (u.pushSubscriptions.length > MAX_SUBS_PER_USER) {
      u.pushSubscriptions = u.pushSubscriptions.slice(-MAX_SUBS_PER_USER);
    }

    await writeBlob(USERS_KEY, data);
    return res.status(200).json({ ok: true });
  }

  // ── send-daily-reminders: cron fan-out ─────────────────────────────────
  if (action === 'send-daily-reminders' && req.method === 'GET') {
    if (!cronAuthorised(req)) return res.status(401).json({ error: 'unauthorised' });
    if (!getWebPush()) return res.status(503).json({ error: 'push not configured (missing VAPID env vars)' });

    const today = sydneyToday();
    const data = await readBlob(USERS_KEY, { users: [] });
    const users = data.users || [];

    const payload = {
      title: 'Did you log your hours?',
      body: "Quick reminder — tap to log today's hours before you knock off.",
      url: '/my-day?openHours=1',
      tag: 'buhl-daily-hours',
    };

    let sent = 0, skipped = 0, pruned = 0;

    for (const u of users) {
      // Tradies + LHs both self-log via My Day; both should get the reminder.
      if (u.role !== 'tradie' && u.role !== 'leadingHand') continue;
      if (!u.pushSubscriptions || !u.pushSubscriptions.length) continue;

      // Skip if they already logged hours for today
      const logged = await userHasLoggedHoursToday(u, today);
      if (logged) { skipped++; continue; }

      const r = await sendPushToUserId(u.id, payload);
      sent   += (r.sent   || 0);
      pruned += (r.pruned || 0);
    }

    return res.status(200).json({ ok: true, date: today, sent, skipped, pruned });
  }

  // ── send-tag-reminders: weekly compliance digest ───────────────────────
  // Cron-only fan-out: every Monday morning, push a digest to admins and
  // leading hands listing how many tags are expired or expiring in the next
  // 14 days across the jobs they oversee. Silent for users with nothing to
  // do, and silent if the push stack isn't configured.
  if (action === 'send-tag-reminders' && req.method === 'GET') {
    if (!cronAuthorised(req)) return res.status(401).json({ error: 'unauthorised' });
    if (!getWebPush()) return res.status(503).json({ error: 'push not configured (missing VAPID env vars)' });

    const WITHIN_DAYS = 14;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayMs  = today.getTime();
    const cutoffMs = todayMs + WITHIN_DAYS * 24 * 60 * 60 * 1000;

    // Walk visible jobs once; compute per-user expired/soon counts based on
    // role (admin = all jobs; LH = assignedJobIds). dd/mm/yyyy parser is
    // duplicated from /api/tags-expiring — keeps this endpoint self-contained
    // so cron can survive a refactor of that file.
    const parseDDMM = s => {
      if (!s) return NaN;
      const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (m) return new Date(+m[3], +m[2] - 1, +m[1]).getTime();
      const m2 = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m2) return new Date(+m2[1], +m2[2] - 1, +m2[3]).getTime();
      return NaN;
    };

    const jobsBlob = await readBlob('jobs.json', { jobs: [] });
    const allJobs  = jobsBlob.jobs || [];

    // jobId → { expired, soon }
    const tagsByJob = {};
    for (const job of allJobs) {
      let tagsBlob;
      try {
        tagsBlob = await readBlob('jobs/' + job.id + '/tags.json', { tags: [] });
      } catch (e) { continue; }
      let expired = 0, soon = 0;
      for (const t of (tagsBlob.tags || [])) {
        const ms = parseDDMM(t.expiryDate);
        if (!Number.isFinite(ms) || ms > cutoffMs) continue;
        if (ms < todayMs) expired++; else soon++;
      }
      if (expired || soon) tagsByJob[job.id] = { expired, soon, jobName: job.name };
    }

    if (!Object.keys(tagsByJob).length) {
      return res.status(200).json({ ok: true, sent: 0, skipped: 'nothing to flag' });
    }

    const usersData = await readBlob(USERS_KEY, { users: [] });
    const users = usersData.users || [];

    let sent = 0, skipped = 0, pruned = 0;

    for (const u of users) {
      if (u.role !== 'admin' && u.role !== 'leadingHand') continue;
      if (!u.pushSubscriptions || !u.pushSubscriptions.length) { skipped++; continue; }

      // Determine visible jobs for this user
      const visibleIds = (u.role === 'admin')
        ? Object.keys(tagsByJob)
        : Object.keys(tagsByJob).filter(jid => (u.assignedJobIds || []).includes(jid));
      if (!visibleIds.length) { skipped++; continue; }

      let userExpired = 0, userSoon = 0;
      for (const jid of visibleIds) {
        userExpired += tagsByJob[jid].expired;
        userSoon    += tagsByJob[jid].soon;
      }
      if (!userExpired && !userSoon) { skipped++; continue; }

      const titleBits = [];
      if (userExpired) titleBits.push(userExpired + ' expired');
      if (userSoon)    titleBits.push(userSoon + ' due in 14d');
      const title = '⚠ Test & Tag — ' + titleBits.join(' · ');
      const body  = 'Across ' + visibleIds.length + ' job' + (visibleIds.length === 1 ? '' : 's') +
                    '. Tap to retest before they lapse.';

      // Single-job → deep-link to that job's T&T tab; otherwise → /overview
      // (admins/LH have an "expiring tags" surface there now).
      const url = visibleIds.length === 1
        ? '/jobs/' + visibleIds[0] + '#tags'
        : (u.role === 'admin' ? '/overview' : '/my-day');

      const r = await sendPushToUserId(u.id, {
        title, body, url,
        tag: 'buhl-tags-weekly',
      });
      sent   += (r.sent   || 0);
      pruned += (r.pruned || 0);
    }

    return res.status(200).json({ ok: true, sent, skipped, pruned });
  }

  // ── send-inactive-users: Tuesday-morning crew-health push ─────────────
  // Walks every active tradie / LH and finds the date of their most recent
  // time-entry. If it's >7 calendar days ago (and the user has been on the
  // system for at least 7 days — no false-flagging fresh hires), they're
  // counted as inactive. One bundled push goes to admins.
  //
  // Why a Tuesday morning push (and not Monday): Mondays are often light
  // logging days. By Tuesday 09:00 Sydney we know who actually went
  // missing-in-action last week. Cron at "0 23 * * 1" (= Mon 23:00 UTC).
  //
  // Why this matters: a tradie who hasn't logged hours in two weeks is
  // either sick, on leave, working off-the-books, or has effectively
  // quit. None of those are things Daniel wants to discover at payroll.
  //
  // Silent when nothing qualifies — same rule as the digest.
  if (action === 'send-inactive-users' && req.method === 'GET') {
    if (!cronAuthorised(req)) return res.status(401).json({ error: 'unauthorised' });
    if (!getWebPush()) return res.status(503).json({ error: 'push not configured (missing VAPID env vars)' });

    const STALE_DAYS = 7;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();

    const usersData = await readBlob(USERS_KEY, { users: [] });
    const candidates = (usersData.users || []).filter(u =>
      (u.role === 'tradie' || u.role === 'leadingHand') &&
      !u.archived);

    // Only flag users who have actually been around long enough to have logged.
    const eligible = candidates.filter(u => {
      const c = u.createdAt ? Date.parse(u.createdAt) : NaN;
      return !Number.isFinite(c) || (now - c) / DAY_MS >= STALE_DAYS;
    });

    const { list } = require('@vercel/blob');
    const token = process.env.BLOB_READ_WRITE_TOKEN;

    // Per-user list call. Cheap — scoped prefix, sorted in storage so
    // we only care about the newest pathname.
    const inactive = [];
    await Promise.all(eligible.map(async u => {
      let latest = '';
      try {
        const r = await list({ prefix: `users/${u.id}/time-entries/`, token, limit: 200 });
        for (const b of (r.blobs || [])) {
          const m = b.pathname.match(/\/time-entries\/(\d{4}-\d{2}-\d{2})\.json$/);
          if (m && m[1] > latest) latest = m[1];
        }
      } catch (e) { /* treat as no entries */ }

      // No entries ever AND created >7d ago → inactive.
      // Has entries → check date.
      let isStale = false;
      if (!latest) {
        isStale = true;
      } else {
        const t = Date.parse(latest + 'T00:00:00Z');
        if (Number.isFinite(t) && (now - t) / DAY_MS >= STALE_DAYS) isStale = true;
      }
      if (isStale) {
        inactive.push({
          id: u.id, username: u.username, role: u.role,
          lastEntryDate: latest || null,
        });
      }
    }));

    const admins = (usersData.users || []).filter(u =>
      u.role === 'admin' &&
      !u.archived &&
      Array.isArray(u.pushSubscriptions) && u.pushSubscriptions.length);

    if (!admins.length) {
      return res.status(200).json({ ok: true, sent: 0, skipped: 'no admin subscribers', inactiveCount: inactive.length });
    }
    if (!inactive.length) {
      return res.status(200).json({ ok: true, sent: 0, skipped: 'no inactive crew' });
    }

    // Body: list names if ≤4, else "N crew · Sam, Riley, Casey, +3".
    inactive.sort((a, b) => (a.username || '').localeCompare(b.username || ''));
    const names = inactive.map(u => u.username).filter(Boolean);
    let body;
    if (names.length <= 4) {
      body = names.join(', ');
    } else {
      body = `${names.length} crew · ${names.slice(0, 3).join(', ')}, +${names.length - 3}`;
    }
    const title = inactive.length === 1
      ? `${names[0]} hasn’t logged hours in 7+ days`
      : `${inactive.length} crew inactive 7+ days`;

    const payload = {
      title, body,
      url: '/admin/crew',
      tag: 'buhl-inactive-crew-' + new Date().toISOString().slice(0, 10),
    };

    let sent = 0, pruned = 0;
    for (const u of admins) {
      const r = await sendPushToUserId(u.id, payload);
      sent   += (r.sent   || 0);
      pruned += (r.pruned || 0);
    }

    return res.status(200).json({
      ok: true, sent, pruned,
      inactiveCount: inactive.length,
      inactive: inactive.map(u => ({
        id: u.id, username: u.username, role: u.role,
        lastEntryDate: u.lastEntryDate,
      })),
    });
  }

  return res.status(400).json({ error: 'unknown action' });
};
