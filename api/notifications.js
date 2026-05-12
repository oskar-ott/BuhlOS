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

  // ── send-daily-digest: end-of-day push for admins ─────────────────────
  // Daniel lies awake wondering "did Sam log hours? did materials arrive?
  // did we price that variation?". This cron answers all three before he
  // asks. Runs ~5pm Sydney; one push per admin with today's roll-up.
  //
  // Aggregated from the same blobs the admin Overview already reads — no
  // new endpoints, no new schemas. Best-effort; cron failures don't queue.
  if (action === 'send-daily-digest' && req.method === 'GET') {
    if (!cronAuthorised(req)) return res.status(401).json({ error: 'unauthorised' });
    if (!getWebPush()) return res.status(503).json({ error: 'push not configured (missing VAPID env vars)' });

    const today = sydneyToday();
    const { list } = require('@vercel/blob');
    const token = process.env.BLOB_READ_WRITE_TOKEN;

    // Hours submitted today (across all users) — walk every per-user
    // time-entries blob for today's date. Same path /api/time-entries-overview
    // walks; inlined here so the cron stays self-contained.
    let hoursSubmittedCount = 0;
    let hoursSubmittedTotal = 0;
    let hoursPendingCount   = 0;
    try {
      const r = await list({ prefix: 'users/', token, limit: 5000 });
      const blobs = (r.blobs || []).filter(b =>
        b.pathname.endsWith(`/time-entries/${today}.json`));
      const entries = (await Promise.all(blobs.map(async b => {
        try {
          const rr = await fetch(b.url + '?t=' + Date.now(), { cache: 'no-store' });
          if (!rr.ok) return null;
          return await rr.json();
        } catch { return null; }
      }))).filter(Boolean);
      for (const e of entries) {
        if (e.status === 'submitted' || e.status === 'approved') {
          hoursSubmittedCount++;
          hoursSubmittedTotal += Number(e.totalHours) || 0;
        }
        if (e.status === 'submitted') hoursPendingCount++;
      }
    } catch (e) { console.error('digest hours walk failed', e); }

    // Snags opened/resolved today — walk per-job data blobs.
    let snagsOpenedToday = 0;
    let snagsResolvedToday = 0;
    try {
      const jobs = (await readBlob('jobs.json', { jobs: [] })).jobs || [];
      const active = jobs.filter(j => (j.status || 'active') === 'active');
      for (const j of active) {
        let d;
        try { d = await readBlob(`jobs/${j.id}/data.json`, { snags: [] }); }
        catch { continue; }
        for (const s of (d.snags || [])) {
          const created = (s.createdAt || s.date || '').slice(0, 10);
          const closed  = (s.closedAt  || '').slice(0, 10);
          if (created === today) snagsOpenedToday++;
          if (closed  === today) snagsResolvedToday++;
        }
      }
    } catch (e) { console.error('digest snags walk failed', e); }

    const usersData = await readBlob(USERS_KEY, { users: [] });
    const admins = (usersData.users || []).filter(u =>
      u.role === 'admin' &&
      !u.archived &&
      Array.isArray(u.pushSubscriptions) && u.pushSubscriptions.length);

    if (!admins.length) {
      return res.status(200).json({ ok: true, date: today, sent: 0, skipped: 'no admin subscribers' });
    }

    // Nothing-to-report case: skip the push entirely. Brief §17 rule —
    // don't make him read "0 hours, 0 snags". Silence is the signal.
    if (!hoursSubmittedCount && !hoursPendingCount && !snagsOpenedToday && !snagsResolvedToday) {
      return res.status(200).json({ ok: true, date: today, sent: 0, skipped: 'nothing to report' });
    }

    // Compose a single tight line — "5 entries · 24.5h · 2 pending · 1 snag opened · 1 resolved".
    const bits = [];
    if (hoursSubmittedCount) bits.push(`${hoursSubmittedCount} entr${hoursSubmittedCount === 1 ? 'y' : 'ies'} · ${hoursSubmittedTotal.toFixed(1)}h`);
    if (hoursPendingCount)   bits.push(`${hoursPendingCount} pending`);
    if (snagsOpenedToday)    bits.push(`${snagsOpenedToday} snag${snagsOpenedToday === 1 ? '' : 's'} opened`);
    if (snagsResolvedToday)  bits.push(`${snagsResolvedToday} resolved`);

    const payload = {
      title: 'End of day',
      body: bits.join(' · '),
      url: '/admin/operations',
      tag: 'buhl-daily-digest-' + today,
    };

    let sent = 0, pruned = 0;
    for (const u of admins) {
      const r = await sendPushToUserId(u.id, payload);
      sent   += (r.sent   || 0);
      pruned += (r.pruned || 0);
    }

    return res.status(200).json({
      ok: true, date: today, sent, pruned,
      digest: { hoursSubmittedCount, hoursSubmittedTotal, hoursPendingCount, snagsOpenedToday, snagsResolvedToday },
    });
  }

  return res.status(400).json({ error: 'unknown action' });
};
