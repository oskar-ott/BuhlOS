// Pure notification routing (#162).
//
// The eligibility brain of the platform `notify()` engine, kept as a STANDALONE
// CJS module so the production serverless runtime (`api/_lib/notify.js`) can
// require it directly (no `.ts` at runtime, no `src/` reach) AND a fast unit
// table can import it via createRequire — the same house pattern as
// api/_lib/cron-auth.js + its cron-auth-api.test.ts.
//
// Pure + side-effect-free: audience + per-user prefs + an event definition go
// in, a recipient list (with the channels each recipient should receive on)
// comes out. No blob reads, no push sends, no Date.now(). The runtime resolves
// the audience from users.json, calls routeEvent() to decide WHO gets WHAT,
// then injects the real deliverers (push.js / email.js).
//
// Why pure matters here: the failure mode this guards against — a muting bug
// silently swallowing a payroll-approval push — is exactly what a fast table
// catches and a manual device test does not.
//
// Contract enforced (issue #162 ACs):
//   - missing `notificationPrefs` key   → channel ON (documented default;
//     a user who never opened the panel notices ZERO change);
//   - missing `notificationPrefs` object → all channels ON;
//   - an `alwaysOn` event ignores prefs entirely (reserved for actionable
//     signal a user must not be able to mute — hours rejected, the office
//     inbox);
//   - the `email` channel is only offered when the event DECLARES it AND email
//     is configured — v1 declares none, so nothing ever fake-sends;
//   - unknown / stale pref keys are ignored, never stripped (the prefs
//     endpoint owns the store).

'use strict';

// The four documented preference keys. MUST stay 1:1 with
// api/notification-prefs.js `VALID_KEYS` and the `NotificationItem` kind union
// in src/domains/platform/notification-item.ts — a parity test in
// notification-item.test.ts pins all three together.
const PREF_KEYS = [
  'hoursApproved',
  'dailyHoursReminder',
  'dailyDigest',
  'tagReminders',
];

// Delivery channels a notification can travel on. v1 is push-only; `email` is
// wired as a seam (declared by no event yet) so a later event can opt in
// without re-plumbing the engine.
const CHANNELS = ['push', 'email'];

/**
 * Resolve whether a single pref key is ON for a user.
 *
 * A missing key — and a missing object — both mean ON (the documented default).
 * Any non-boolean stored value is coerced exactly the way
 * api/notification-prefs.js does (`!!stored[k]`), so a corrupt value can never
 * read as a surprise "on" when the server treats it as off, or vice versa.
 */
function prefEnabled(prefs, key) {
  if (!prefs || typeof prefs !== 'object') return true;
  if (!(key in prefs)) return true;
  return Boolean(prefs[key]);
}

/**
 * Whether the event's pref gate is open for this user. `alwaysOn` (or a null
 * prefKey) bypasses prefs entirely.
 */
function gateOpenFor(event, user) {
  if (event.alwaysOn === true) return true;
  if (event.prefKey == null) return true;
  return prefEnabled(user && user.notificationPrefs, event.prefKey);
}

/**
 * The channels this event should deliver to this user. Empty ⇒ fully
 * suppressed (muted, or no channel survives — e.g. an email-only event when
 * email is unconfigured). Email is only ever offered when configured.
 */
function channelsForUser(event, user, env) {
  if (!gateOpenFor(event, user)) return [];
  const emailConfigured = !!(env && env.emailConfigured);
  return (event.channels || []).filter((ch) =>
    ch === 'email' ? emailConfigured : true
  );
}

/**
 * Route one event across an already-resolved audience.
 *
 * @param {object} event    registry definition { kind, prefKey|null, alwaysOn?, channels[] }
 * @param {Array<object>} audience  user records the runtime decided are in-audience
 * @param {object} env      { emailConfigured: boolean }
 * @returns {{ deliver: Array<{userId, channels}>, skipped: Array<{userId, reason}> }}
 *
 * Pure: same inputs ⇒ same output. The caller de-dupes the audience and does
 * the actual sending on the returned channels. Skip reasons:
 *   - 'muted'        the gating pref is explicitly false for this user
 *   - 'no-channels'  every declared channel resolved away
 */
function routeEvent(event, audience, env) {
  const deliver = [];
  const skipped = [];
  const list = Array.isArray(audience) ? audience : [];

  for (const user of list) {
    if (!user || !user.id) continue;
    if (!gateOpenFor(event, user)) {
      skipped.push({ userId: user.id, reason: 'muted' });
      continue;
    }
    const channels = channelsForUser(event, user, env);
    if (!channels.length) {
      skipped.push({ userId: user.id, reason: 'no-channels' });
      continue;
    }
    deliver.push({ userId: user.id, channels });
  }

  return { deliver, skipped };
}

module.exports = {
  PREF_KEYS,
  CHANNELS,
  prefEnabled,
  gateOpenFor,
  channelsForUser,
  routeEvent,
};
