// Fires a push notification about a snag.
//
//   POST /api/snag-notify
//   body: {
//     userId,                 // recipient
//     kind: 'assigned' |      // (default) — admin/LH assigned a snag
//           'resolved' |      // — snag was closed; notify the original raiser
//           'reopened',       // — closed snag was reopened; notify the assignee
//     jobId,                  // optional — used to deep-link the notification
//     snag: { id, desc, priority, jobName }
//   }
//
// Best-effort: returns 200 even when push isn't configured (silently no-ops)
// so write paths don't fail when VAPID env vars aren't set.
//
// Permissions:
//   - admin / leadingHand / tradie can trigger this
//   - clients are 403'd
//   - Skips notifying the actor themselves (when actor === recipient)

const { setNoCache } = require('./_lib/blob');
const { requireAuth } = require('./_lib/auth');
const { sendPushToUserId } = require('./_lib/push');

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const me = await requireAuth(req, res);
  if (!me) return;
  if (me.role === 'client') return res.status(403).json({ error: 'forbidden' });

  const { userId, snag, kind = 'assigned' } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!snag || !snag.desc) return res.status(400).json({ error: 'snag.desc required' });
  if (userId === me.id) return res.status(200).json({ ok: true, skipped: 'self' });

  const prio = (snag.priority || 'Medium');
  const jobPrefix = snag.jobName ? '[' + snag.jobName + '] ' : '';
  const desc = String(snag.desc).slice(0, 140);
  const actor = (me.username || '').trim();

  let title, body;
  if (kind === 'resolved') {
    title = '✓ Snag resolved';
    // Tell the raiser who fixed their snag — e.g. "[Atlas Tower] Loose RCD — by chris"
    body  = jobPrefix + desc + (actor ? ' — by ' + actor : '');
  } else if (kind === 'reopened') {
    title = '↺ Snag reopened';
    body  = jobPrefix + desc + (actor ? ' — by ' + actor : '');
  } else {
    // 'assigned' (default)
    title = (prio === 'High' ? '⚠ HIGH · ' : '') + 'Snag assigned to you';
    body  = jobPrefix + desc;
  }

  // jobId may come in the body (preferred) or fall back to a legacy
  // query param. Without it the deep-link drops the user on /jobs/#snags
  // (no job context), so always try to include it.
  const jobId = (req.body && req.body.jobId) || (req.query && req.query.jobId) || '';

  // Deep-link to the specific snag row when we know the id, so the per-job
  // page can scroll-and-flash it on load. Falls back gracefully if jobId or
  // snag.id is missing.
  let url;
  if (jobId && snag.id) {
    url = '/jobs/' + jobId + '?snag=' + encodeURIComponent(snag.id) + '#snags';
  } else if (jobId) {
    url = '/jobs/' + jobId + '#snags';
  } else {
    url = '/my-day';
  }

  const result = await sendPushToUserId(userId, {
    title,
    body,
    url,
    tag: 'buhl-snag-' + kind + '-' + (snag.id || ''),
  });
  return res.status(200).json({ ok: true, result });
};
