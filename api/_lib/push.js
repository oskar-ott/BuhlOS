// Shared web-push helper.
//
// Provides one function:
//
//   sendPushToUserId(userId, payload, opts) → { sent, pruned, skipped }
//
// - payload is a plain object: { title, body, url, tag }; serialised here.
// - Best-effort: errors are logged but never thrown. Callers can fire-and-forget
//   (`.catch(() => {})`) because business workflows (approve, reject, log) must
//   not fail when push is misconfigured or a user has no subscriptions.
// - Prunes dead subscriptions (HTTP 404 / 410 from the push service) in-place
//   on users.json so the list doesn't accumulate forever.
//
// Reads VAPID config from the same env vars as /api/notifications:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (optional).
// If VAPID isn't configured, sends are silently skipped.

const { readBlob, writeBlob } = require('./blob');

const USERS_KEY = 'users.json';

function getWebPush() {
  let wp;
  try { wp = require('web-push'); }
  catch (e) { return null; }
  const pub  = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const sub  = process.env.VAPID_SUBJECT || 'mailto:admin@buhl.local';
  if (!pub || !priv) return null;
  wp.setVapidDetails(sub, pub, priv);
  return wp;
}

async function sendPushToUserId(userId, payload, opts = {}) {
  const wp = getWebPush();
  if (!wp) return { sent: 0, pruned: 0, skipped: 'push not configured' };
  if (!userId) return { sent: 0, pruned: 0, skipped: 'no userId' };

  const data = await readBlob(USERS_KEY, { users: [] });
  const u = (data.users || []).find(x => x.id === userId);
  if (!u) return { sent: 0, pruned: 0, skipped: 'user not found' };
  if (!u.pushSubscriptions || !u.pushSubscriptions.length) {
    return { sent: 0, pruned: 0, skipped: 'no subscriptions' };
  }

  const body = JSON.stringify(payload || {});
  const ttl = (opts && opts.ttlSeconds) || 6 * 60 * 60; // 6h default

  const keep = [];
  let sent = 0, pruned = 0;
  for (const s of u.pushSubscriptions) {
    try {
      await wp.sendNotification(
        { endpoint: s.endpoint, keys: s.keys },
        body,
        { TTL: ttl }
      );
      sent++;
      keep.push(s);
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        pruned++; // gone — drop
      } else {
        keep.push(s); // transient — keep
        console.error('push send error for user', userId, e && e.message || e);
      }
    }
  }
  if (pruned > 0) {
    u.pushSubscriptions = keep;
    try { await writeBlob(USERS_KEY, data); } catch (e) { /* swallow */ }
  }
  return { sent, pruned, skipped: null };
}

module.exports = { getWebPush, sendPushToUserId };
