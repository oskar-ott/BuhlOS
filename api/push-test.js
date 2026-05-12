// Self-fire test push — for QA after enabling notifications.
//
//   POST /api/push-test
//        body: { title?, body?, url? }   (all optional)
//
// Sends a single push to every subscription the current user has
// registered (max 5, see /api/notifications?action=subscribe). Default
// payload is a clearly-labelled "Test push" with body that includes
// the timestamp so receiving + rendering bugs are obvious.
//
// Why this exists:
//   When a user (especially Daniel testing on a new phone) enables
//   push, they want to see *immediately* whether it works. The first
//   real notification they'd otherwise get could be 24 hours away
//   (next morning's daily reminder, or even longer for the weekly
//   ones). This endpoint replaces "try and wait" with "tap and see".
//
//   Doubles as a debugging tool for the admin who wants to verify
//   their VAPID keys are configured and the service worker is alive
//   on a particular device.
//
// Response:
//   { sent: N, pruned: M, payload: { ... } }
//
// Permissions: any authenticated user. The push goes only to *their
// own* subscriptions — no leakage. Body / title overrides are accepted
// but capped to 140 chars to prevent abusing the endpoint as a
// general-purpose pinger.

const { setNoCache } = require('./_lib/blob');
const { getCurrentUser } = require('./_lib/auth');
const { getWebPush, sendPushToUserId } = require('./_lib/push');

const MAX_TEXT = 140;

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'not authenticated' });
  if (!getWebPush()) return res.status(503).json({ error: 'push not configured (missing VAPID env vars)' });

  const body = req.body || {};
  const now = new Date();
  const stamp = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    hour: '2-digit', minute: '2-digit',
  }).format(now);

  // Clamp custom text; default to a clearly-labelled test message that
  // includes the stamp so renderer regressions are obvious.
  const title = body.title
    ? String(body.title).slice(0, MAX_TEXT)
    : 'Test push from BuhlOS';
  const text = body.body
    ? String(body.body).slice(0, MAX_TEXT)
    : `If you're reading this, push is working. ${stamp} Sydney.`;
  const url = body.url
    ? String(body.url).slice(0, MAX_TEXT)
    : '/my-day';

  const payload = {
    title, body: text, url,
    tag: 'buhl-test-' + Date.now(),
  };

  const r = await sendPushToUserId(me.id, payload);

  return res.status(200).json({
    sent:   r.sent || 0,
    pruned: r.pruned || 0,
    skipped: r.skipped || 0,
    payload,
  });
};
