// User-level push notification preferences.
//
//   GET  /api/notification-prefs           → returns current user's prefs
//   PUT  /api/notification-prefs            → update (partial PATCH semantics)
//        body: { key: boolean, ... }
//
// Keys (all default true; only the keys relevant to the user's role
// are actually consulted by the cron / push actions):
//
//   dailyHoursReminder  — tradie / LH: "did you log hours?" 16:30 push
//   dailyDigest         — admin:       end-of-day digest 17:00 push
//   staleSnags          — admin:       Monday 09:00 stale-snag triage push
//   tagReminders        — admin / LH:  weekly tag-expiry digest
//   hoursApproved       — tradie / LH: per-entry approval push to recipient
//   snagAssigned        — LH / admin:  per-snag auto-assign push to recipient
//
// Why this exists:
//   Push is a hammer — once a user has it on, they get every type. Some
//   users will absolutely want the hours-approved ping but find the daily
//   digest noisy. Per-type opt-out keeps the useful pushes deliverable
//   while letting people silence the rest.
//
// Storage:
//   On the user object in users.json: `notificationPrefs: { <key>: bool }`.
//   Missing keys are treated as `true` so existing users keep the current
//   behaviour without migration.
//
// Permissions:
//   Any authenticated user can read + write their own prefs only. There
//   is no admin-overrides-other-user endpoint — by design; if Daniel
//   wants Sam to get the reminder he can ask Sam, not toggle it for him.
//
// Wiring note:
//   This PR ships the storage + endpoint only. The cron actions in
//   /api/notifications need a follow-up commit that consults prefs
//   before sending to each user; held out of this PR to avoid colliding
//   with the in-flight digest (#68) and stale-snag (#69) PRs.

const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { getCurrentUser } = require('./_lib/auth');

const VALID_KEYS = new Set([
  'dailyHoursReminder',
  'dailyDigest',
  'staleSnags',
  'tagReminders',
  'hoursApproved',
  'snagAssigned',
]);

// Resolve a user's effective prefs — missing keys default true so behaviour
// is unchanged for existing users.
function effective(stored) {
  const out = {};
  for (const k of VALID_KEYS) {
    out[k] = (stored && k in stored) ? !!stored[k] : true;
  }
  return out;
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'not authenticated' });

  if (req.method === 'GET') {
    // Re-read users.json fresh — token in the request is light, the prefs
    // are tiny, and we want the canonical value not whatever was on the
    // session at sign-in.
    const data = await readBlob('users.json', { users: [] });
    const u = (data.users || []).find(x => x.id === me.id);
    if (!u) return res.status(404).json({ error: 'user not found' });
    return res.status(200).json({
      prefs: effective(u.notificationPrefs),
      role: me.role,
    });
  }

  if (req.method === 'PUT') {
    const body = req.body || {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'body must be an object of key→boolean' });
    }
    // Validate keys + types up-front so a bad payload doesn't half-write.
    const updates = {};
    for (const [k, v] of Object.entries(body)) {
      if (!VALID_KEYS.has(k)) {
        return res.status(400).json({ error: 'unknown pref key: ' + k });
      }
      if (typeof v !== 'boolean') {
        return res.status(400).json({ error: 'pref values must be boolean: ' + k });
      }
      updates[k] = v;
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'no recognised pref keys in body' });
    }

    const data = await readBlob('users.json', { users: [] });
    const u = (data.users || []).find(x => x.id === me.id);
    if (!u) return res.status(404).json({ error: 'user not found' });

    u.notificationPrefs = { ...(u.notificationPrefs || {}), ...updates };
    await writeBlob('users.json', data);

    return res.status(200).json({
      prefs: effective(u.notificationPrefs),
      role: me.role,
    });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
