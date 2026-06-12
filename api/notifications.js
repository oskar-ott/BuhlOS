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
const { getCurrentUser, isAdminRole, isLeadingHandRole, isFieldRole, isClientRole, isDisabledUser } = require('./_lib/auth');
const { getWebPush, sendPushToUserId } = require('./_lib/push');
// #381: fail-closed cron gate (503 in production when CRON_SECRET unset).
const { requireCron } = require('./_lib/cron-auth');
const { readLeave, approvedLeaveByUserDate } = require('./_lib/leave');
const { expiringTagRows, expiringCalibrationRows, newCrossings } = require('./_lib/tag-compliance');
const { licenceRows, newLicenceCrossings } = require('./_lib/licence-compliance');
const { listAllAssets } = require('./_lib/assets');

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
    if (!requireCron(req, res)) return;
    if (!getWebPush()) return res.status(503).json({ error: 'push not configured (missing VAPID env vars)' });

    const today = sydneyToday();
    const data = await readBlob(USERS_KEY, { users: [] });
    const users = data.users || [];

    let leaveToday = {};
    try {
      const leaveData = await readLeave();
      leaveToday = approvedLeaveByUserDate(leaveData.requests, today, today);
    } catch { leaveToday = {}; }

    const payload = {
      title: 'Did you log your hours?',
      body: "Quick reminder — tap to log today's hours before you knock off.",
      url: '/phil/my-day',
      tag: 'buhl-daily-hours',
    };

    let sent = 0, skipped = 0, pruned = 0;

    for (const u of users) {
      // Tradies + LHs both self-log via My Day; both should get the reminder.
      if (!isFieldRole(u.role) && !isLeadingHandRole(u.role)) continue;
      if (!u.pushSubscriptions || !u.pushSubscriptions.length) continue;

      // Skip if they already logged hours for today
      const logged = await userHasLoggedHoursToday(u, today);
      if (logged) { skipped++; continue; }
      // #333: never nag a worker on approved leave today.
      if (leaveToday[u.id + '|' + today]) { skipped++; continue; }

      const r = await sendPushToUserId(u.id, payload);
      sent   += (r.sent   || 0);
      pruned += (r.pruned || 0);
    }

    return res.status(200).json({ ok: true, date: today, sent, skipped, pruned });
  }

  // ── send-tag-reminders: daily compliance threshold alerts (#305) ───────
  // Cron-only fan-out, daily. Computes expiring/expired test tags (across
  // ALL jobs) and instrument calibrations (asset register) via the SHARED
  // api/_lib/tag-compliance.js, then pushes only items that NEWLY crossed
  // an alert threshold (14d → 7d → expired) since the last run. Crossing
  // state is persisted in tag-reminder-state.json so the same tag never
  // re-alerts every morning — at most three pushes over its lifetime.
  //
  // Recipients (notificationPrefs.tagReminders opt-out respected):
  //   - tags:         admins (all jobs) + leading hands (their assigned jobs)
  //   - calibrations: admins + whoever currently HOLDS the instrument
  //
  // Silent when nothing crossed; state is still pruned so a retested item
  // resets its alert lifecycle.
  if (action === 'send-tag-reminders' && req.method === 'GET') {
    if (!requireCron(req, res)) return;
    if (!getWebPush()) return res.status(503).json({ error: 'push not configured (missing VAPID env vars)' });

    const WITHIN_DAYS = 14;
    const STATE_KEY = 'tag-reminder-state.json';

    const jobsBlob = await readBlob('jobs.json', { jobs: [] });
    const allJobs = jobsBlob.jobs || [];
    const tagsByJobId = {};
    await Promise.all(allJobs.map(async job => {
      try {
        const blob = await readBlob('jobs/' + job.id + '/tags.json', { tags: [] });
        tagsByJobId[job.id] = blob.tags || [];
      } catch (e) { tagsByJobId[job.id] = []; }
    }));
    const tagRows = expiringTagRows(allJobs, tagsByJobId, { withinDays: WITHIN_DAYS });

    const usersData = await readBlob(USERS_KEY, { users: [] });
    const users = usersData.users || [];
    const nameById = {};
    for (const u of users) nameById[u.id] = u.username || u.name || u.id;

    let calRows = [];
    try {
      const assets = await listAllAssets();
      calRows = expiringCalibrationRows(assets, { withinDays: WITHIN_DAYS, nameById });
    } catch (e) { calRows = []; }

    const stateBlob = await readBlob(STATE_KEY, { entries: {} });
    const { crossed, nextState } = newCrossings(
      tagRows.concat(calRows),
      (stateBlob && stateBlob.entries) || {}
    );

    // State is written AFTER the sends: if the function dies mid-fan-out the
    // next run re-alerts (duplicate push) rather than silently losing the
    // alert — the right failure mode for a compliance loop.
    if (!crossed.length) {
      await writeBlob(STATE_KEY, { entries: nextState });
      return res.status(200).json({ ok: true, crossed: 0, sent: 0 });
    }

    let sent = 0, skipped = 0, pruned = 0;

    for (const u of users) {
      // NOT gated to isStaffRole: a field-tier tradie HOLDING a calibrated
      // instrument must hear about it too. Clients and disabled accounts
      // never get compliance pushes; everyone else is decided by the per-row
      // visibility filter below.
      if (isClientRole(u.role) || isDisabledUser(u)) continue;
      // First sender to actually consult the notification-prefs seam — the
      // documented `tagReminders` key covers the whole compliance loop.
      if (u.notificationPrefs && u.notificationPrefs.tagReminders === false) { skipped++; continue; }
      if (!u.pushSubscriptions || !u.pushSubscriptions.length) { skipped++; continue; }

      const admin = isAdminRole(u.role);
      const mine = crossed.filter(r => {
        if (r.kind === 'tag') {
          return admin || (isLeadingHandRole(u.role) && (u.assignedJobIds || []).includes(r.jobId));
        }
        return admin || r.holderId === u.id;
      });
      if (!mine.length) { skipped++; continue; }

      const nExpired = mine.filter(r => r.threshold === 'expired').length;
      const n7  = mine.filter(r => r.threshold === 't7').length;
      const n14 = mine.filter(r => r.threshold === 't14').length;
      const titleBits = [];
      if (nExpired) titleBits.push(nExpired + ' expired');
      if (n7)  titleBits.push(n7 + ' due in 7d');
      if (n14) titleBits.push(n14 + ' due in 14d');
      const title = '⚠ Test & Tag — ' + titleBits.join(' · ');

      const names = mine.slice(0, 3).map(r =>
        r.kind === 'tag'
          ? ((r.applianceType || r.tagNumber || 'tag') + ' at ' + r.jobName)
          : (r.assetName + ' calibration')
      );
      const body = names.join(', ') + (mine.length > 3 ? ' +' + (mine.length - 3) + ' more' : '') +
                   '. Tap to sort the retest.';

      // Post-cutover targets only (every legacy URL is a 307 now): admins →
      // the /gear compliance board; a LH whose crossings sit on one job →
      // that job's Phil page; a holder alerted about their own instrument →
      // their Phil gear list; otherwise the Phil home.
      const tagJobIds = [...new Set(mine.filter(r => r.kind === 'tag').map(r => r.jobId))];
      const url = admin
        ? '/gear'
        : tagJobIds.length === 1
          ? '/phil/jobs/' + tagJobIds[0]
          : tagJobIds.length === 0
            ? '/phil/gear'
            : '/phil/my-day';

      const r = await sendPushToUserId(u.id, {
        title, body, url,
        tag: 'buhl-tag-alerts',
      });
      sent   += (r.sent   || 0);
      pruned += (r.pruned || 0);
    }

    await writeBlob(STATE_KEY, { entries: nextState });
    return res.status(200).json({ ok: true, crossed: crossed.length, sent, skipped, pruned });
  }

  // ── send-licence-reminders: daily worker-ticket threshold alerts (#331) ─
  // Same compliance-loop mechanics as send-tag-reminders, for HUMANS: the
  // shared api/_lib/licence-compliance.js projects the credential register
  // into expiring/expired rows (60d window, renewals supersede, archived
  // workers never alert), and only NEW band crossings (60d → 14d → expired)
  // push — state in licence-reminder-state.json, so a ticket alerts at most
  // three times over its life. Admins get the whole digest (/employees);
  // each worker hears about their OWN tickets only (/v2/phil self-view).
  // PII: pushes name the ticket type, never the licence number.
  if (action === 'send-licence-reminders' && req.method === 'GET') {
    if (!requireCron(req, res)) return;
    if (!getWebPush()) return res.status(503).json({ error: 'push not configured (missing VAPID env vars)' });

    const WITHIN_DAYS = 60;
    const STATE_KEY = 'licence-reminder-state.json';

    const credsBlob = await readBlob('workforce/credentials.json', { credentials: [] });
    const usersData = await readBlob(USERS_KEY, { users: [] });
    const users = usersData.users || [];
    const rows = licenceRows(credsBlob.credentials || [], users, { withinDays: WITHIN_DAYS });

    const stateBlob = await readBlob(STATE_KEY, { entries: {} });
    const { crossed, nextState } = newLicenceCrossings(rows, (stateBlob && stateBlob.entries) || {});

    // State is written AFTER the sends — same failure mode choice as the
    // tag loop: a mid-fan-out crash re-alerts rather than silently losing.
    if (!crossed.length) {
      await writeBlob(STATE_KEY, { entries: nextState });
      return res.status(200).json({ ok: true, crossed: 0, sent: 0 });
    }

    let sent = 0, skipped = 0, pruned = 0;
    for (const u of users) {
      if (isClientRole(u.role) || isDisabledUser(u)) continue;
      if (u.notificationPrefs && u.notificationPrefs.licenceReminders === false) { skipped++; continue; }
      if (!u.pushSubscriptions || !u.pushSubscriptions.length) { skipped++; continue; }

      const admin = isAdminRole(u.role);
      // Admins chase everyone's renewals; a worker hears about their own.
      const mine = crossed.filter(r => admin || r.userId === u.id);
      if (!mine.length) { skipped++; continue; }

      const nExpired = mine.filter(r => r.threshold === 'expired').length;
      const n14 = mine.filter(r => r.threshold === 't14').length;
      const n60 = mine.filter(r => r.threshold === 't60').length;
      const titleBits = [];
      if (nExpired) titleBits.push(nExpired + ' expired');
      if (n14) titleBits.push(n14 + ' due in 14d');
      if (n60) titleBits.push(n60 + ' due in 60d');
      const title = (admin ? '⚠ Licences — ' : '⚠ Your tickets — ') + titleBits.join(' · ');

      const names = mine.slice(0, 3).map(r => (admin ? r.label + ' — ' + r.userName : r.label));
      const body = names.join(', ') + (mine.length > 3 ? ' +' + (mine.length - 3) + ' more' : '') +
                   (admin ? '. Tap to sort renewals.' : '. See the office about the renewal.');

      const r = await sendPushToUserId(u.id, {
        title, body,
        url: admin ? '/employees' : '/v2/phil',
        tag: 'buhl-licence-alerts',
      });
      sent   += (r.sent   || 0);
      pruned += (r.pruned || 0);
    }

    await writeBlob(STATE_KEY, { entries: nextState });
    return res.status(200).json({ ok: true, crossed: crossed.length, sent, skipped, pruned });
  }

  // ── send-daily-digest: end-of-day push for admins ─────────────────────
  // Daniel lies awake wondering "did Sam log hours? did materials arrive?
  // did we price that variation?". This cron answers all three before he
  // asks. Runs ~5pm Sydney; one push per admin with today's roll-up.
  //
  // Aggregated from the same blobs the admin Overview already reads — no
  // new endpoints, no new schemas. Best-effort; cron failures don't queue.
  if (action === 'send-daily-digest' && req.method === 'GET') {
    if (!requireCron(req, res)) return;
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
      isAdminRole(u.role) &&
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
      url: '/command-centre',
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

  // ── send-stale-snags: Monday-morning triage push for admins ───────────
  // Snags rot in silence. A snag opened three weeks ago without a follow-up
  // is the kind of thing that costs money at handover. This cron walks all
  // open snags on active jobs and pushes admins a single line: "N stale
  // snags · X high priority", with a link straight to /admin/snags.
  //
  // Age thresholds are tuned to priority — a High open >3 days is louder
  // than a Low at the same age, because real defects don't wait a fortnight.
  //   High:   stale after 3 days
  //   Medium: stale after 7 days
  //   Low:    stale after 14 days
  //
  // Runs Mon 09:00 Sydney (= Sun 23:00 UTC). Skipped entirely when nothing
  // qualifies — same "silence is the signal" rule as the daily digest.
  if (action === 'send-stale-snags' && req.method === 'GET') {
    if (!requireCron(req, res)) return;
    if (!getWebPush()) return res.status(503).json({ error: 'push not configured (missing VAPID env vars)' });

    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    const thresholdDays = { High: 3, Medium: 7, Low: 14 };

    let stale = [];
    try {
      const jobs = (await readBlob('jobs.json', { jobs: [] })).jobs || [];
      const active = jobs.filter(j => (j.status || 'active') === 'active');
      for (const j of active) {
        let d;
        try { d = await readBlob(`jobs/${j.id}/data.json`, { snags: [] }); }
        catch { continue; }
        for (const s of (d.snags || [])) {
          if ((s.status || 'Open') !== 'Open') continue;
          const created = s.createdAt || s.date || '';
          if (!created) continue;
          const t = Date.parse(created);
          if (!Number.isFinite(t)) continue;
          const ageDays = (now - t) / DAY_MS;
          const prio = s.priority || 'Medium';
          const threshold = thresholdDays[prio] ?? thresholdDays.Medium;
          if (ageDays < threshold) continue;
          stale.push({ jobId: j.id, jobName: j.name, priority: prio, ageDays });
        }
      }
    } catch (e) { console.error('stale-snags walk failed', e); }

    const usersData = await readBlob(USERS_KEY, { users: [] });
    const admins = (usersData.users || []).filter(u =>
      isAdminRole(u.role) &&
      !u.archived &&
      Array.isArray(u.pushSubscriptions) && u.pushSubscriptions.length);

    if (!admins.length) {
      return res.status(200).json({ ok: true, sent: 0, skipped: 'no admin subscribers', staleCount: stale.length });
    }
    if (!stale.length) {
      return res.status(200).json({ ok: true, sent: 0, skipped: 'no stale snags' });
    }

    const byPriority = { High: 0, Medium: 0, Low: 0 };
    const jobSet = new Set();
    let oldestDays = 0;
    for (const s of stale) {
      byPriority[s.priority] = (byPriority[s.priority] || 0) + 1;
      jobSet.add(s.jobId);
      if (s.ageDays > oldestDays) oldestDays = s.ageDays;
    }

    const bits = [];
    bits.push(`${stale.length} stale snag${stale.length === 1 ? '' : 's'}`);
    if (byPriority.High) bits.push(`${byPriority.High} high priority`);
    if (jobSet.size > 1) bits.push(`across ${jobSet.size} jobs`);
    bits.push(`oldest ${Math.floor(oldestDays)}d`);

    const payload = {
      title: 'Snags need triage',
      body: bits.join(' · '),
      url: '/command-centre',
      tag: 'buhl-stale-snags-' + new Date().toISOString().slice(0, 10),
    };

    let sent = 0, pruned = 0;
    for (const u of admins) {
      const r = await sendPushToUserId(u.id, payload);
      sent   += (r.sent   || 0);
      pruned += (r.pruned || 0);
    }

    return res.status(200).json({
      ok: true, sent, pruned,
      stale: { total: stale.length, byPriority, jobs: jobSet.size, oldestDays: Math.floor(oldestDays) },
    });
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
    if (!requireCron(req, res)) return;
    if (!getWebPush()) return res.status(503).json({ error: 'push not configured (missing VAPID env vars)' });

    const STALE_DAYS = 7;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();

    const usersData = await readBlob(USERS_KEY, { users: [] });
    const candidates = (usersData.users || []).filter(u =>
      (isFieldRole(u.role) || isLeadingHandRole(u.role)) &&
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
      isAdminRole(u.role) &&
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
      url: '/hours',
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
