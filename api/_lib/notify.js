// Platform notification engine — `notify(event)` (#162).
//
// ONE seam every notification flows through. Today's pushes are scattered
// across ~14 call-sites, each calling `sendPushToUserId` directly and NONE of
// them consulting the user's `notificationPrefs` — so the prefs panel (#218)
// is honest-looking but inert: a user can toggle `hoursApproved` off and STILL
// get the approval push. This engine closes that gap. It:
//
//   1. resolves an event's audience (or takes an audience the caller resolved),
//   2. applies each user's per-type `notificationPrefs` via the PURE router
//      `src/domains/platform/notify-routing.ts` (missing key = true — the
//      documented default; `alwaysOn` events bypass prefs),
//   3. delivers on the event's declared channels through the EXISTING
//      `api/_lib/push.js` (and `api/_lib/email.js` ONLY where an event declares
//      email AND email is configured — v1 declares none, so the seam exists and
//      nothing ever fake-sends),
//   4. returns aggregated outcome counts `{ sent, pruned, skipped }`.
//
// Best-effort, ALWAYS. Business flows (approve, reject, log hours) must
// never fail because push is misconfigured or a recipient muted a type — every
// call site fires-and-forgets (`notify(...).catch(() => {})`), exactly as the
// raw `sendPushToUserId(...).catch(() => {})` did. `notify()` itself also
// swallows its own internal errors and still returns a counts object.
//
// `notify()` NEVER writes a business store. The only write it can trigger is
// push.js's existing dead-subscription pruning of users.json (best-effort,
// unchanged). It performs no blob reads of its own unless an event's audience
// resolver asks for one (the pilot events pass their audience in).
//
// Channels are push-only in v1. The registry's `channels` field + the email
// seam below are where #311 (SMS), #321 (Slack/Teams) and the broader #310
// integration framework plug in later — they should name notify() as their
// entry point and add a channel, not add another scattered call-site.

const { sendPushToUserId } = require("./push");
const { isEmailConfigured } = require("./email");
const { routeEvent } = require("./notify-routing");

// ── Event registry ───────────────────────────────────────────────────
//
// Exactly the six documented kinds. Each declares:
//   - prefKey:  the `notificationPrefs` key that gates it, or null when alwaysOn
//   - alwaysOn: true ⇒ ignore prefs (reserved; none of the six are alwaysOn —
//               see the note below on rejections / office-inbox)
//   - channels: delivery channels in priority order (v1: ["push"] for all)
//   - audience: optional human note for the doc; resolution is the caller's
//               (pilot) or a resolver fn (future)
//
// NOTE on alwaysOn (issue #162 audit decision): several LIVE pushes have NO
// pref key — hours REJECTED/REOPENED (`time-entries-reject`/`reopen`), the
// capture-v2 office-inbox push (`observations.js`), cash-watch overruns and
// payroll-reminder. Those are actionable signal a user must not be able to
// mute into a missed payroll rejection or a lost "send to the office" photo.
// When those call-sites are migrated (tracked follow-up, see the PR body) they
// will register as `alwaysOn: true` events with `prefKey: null`, NOT as new
// pref keys the panel (#218) doesn't render. The `alwaysOn` class is built and
// router-tested now so that migration is a registry addition, not a redesign.
const REGISTRY = {
  hoursApproved: {
    kind: "hoursApproved",
    prefKey: "hoursApproved",
    channels: ["push"],
    audience: "the worker whose submitted hours were approved",
  },
  dailyHoursReminder: {
    kind: "dailyHoursReminder",
    prefKey: "dailyHoursReminder",
    channels: ["push"],
    audience: "field + LH who have not logged hours today",
  },
  dailyDigest: {
    kind: "dailyDigest",
    prefKey: "dailyDigest",
    channels: ["push"],
    audience: "admin-tier users with a push subscription",
  },
  tagReminders: {
    kind: "tagReminders",
    prefKey: "tagReminders",
    channels: ["push"],
    audience: "admins (all jobs) + LH (assigned jobs) + instrument holders",
  },
};

function getEventDef(kind) {
  return REGISTRY[kind] || null;
}

// Empty counts shape — the always-returned outcome even on a no-op / error.
function emptyCounts() {
  return { sent: 0, pruned: 0, skipped: 0 };
}

/**
 * Deliver one event.
 *
 * @param {object} event
 * @param {string} event.kind            registry key (one of the six)
 * @param {Array<object>} event.audience user records the caller resolved as the
 *                                        audience (each at least `{ id }`, plus
 *                                        `notificationPrefs` if set). The engine
 *                                        does NOT re-resolve — call-sites already
 *                                        know their recipient(s); crons pass the
 *                                        filtered user list.
 * @param {object} [event.payload]       push payload `{ title, body, url, tag }`
 *                                        shared by all recipients.
 * @param {(user:object)=>object} [event.payloadFor]
 *                                        per-recipient payload builder (used when
 *                                        recipients get different copy, e.g. the
 *                                        tag-reminder digest). Takes precedence
 *                                        over `payload` for that recipient.
 * @param {object} [event.pushOptions]   forwarded to sendPushToUserId (e.g. ttl).
 * @param {object} [deps]                injectable deliverers (tests). Defaults
 *                                        to the real push/email libs.
 * @returns {Promise<{sent:number, pruned:number, skipped:number}>}
 */
async function notify(event, deps = {}) {
  const counts = emptyCounts();
  try {
    if (!event || typeof event !== "object") return counts;

    const def = getEventDef(event.kind);
    if (!def) {
      // Unknown kind is a programming error, not a runtime one — log and no-op
      // rather than throw into a business flow.
      console.error("notify: unknown event kind", event.kind);
      return counts;
    }

    const audience = Array.isArray(event.audience) ? event.audience : [];
    if (!audience.length) return counts;

    const sendPush = deps.sendPushToUserId || sendPushToUserId;
    const emailConfigured =
      typeof deps.isEmailConfigured === "function"
        ? deps.isEmailConfigured()
        : isEmailConfigured();

    // PURE routing: audience + prefs + email-config → who gets which channels.
    const { deliver, skipped } = routeEvent(def, audience, { emailConfigured });
    counts.skipped += skipped.length;

    for (const recipient of deliver) {
      const user = audience.find((u) => u && u.id === recipient.userId);
      const payload =
        typeof event.payloadFor === "function"
          ? event.payloadFor(user)
          : event.payload;

      if (!payload) {
        // No copy to send — count as skipped, never throw.
        counts.skipped += 1;
        continue;
      }

      for (const channel of recipient.channels) {
        if (channel === "push") {
          try {
            // Call shape stays byte-identical to the pre-engine direct call:
            // 2 args when the event has no push options (the common case), the
            // 3rd opts arg only when explicitly provided. push.js defaults opts
            // to {} itself, so this is equivalent and keeps existing call-site
            // tests (which assert a 2-arg call) green.
            const r = event.pushOptions
              ? await sendPush(recipient.userId, payload, event.pushOptions)
              : await sendPush(recipient.userId, payload);
            counts.sent += (r && r.sent) || 0;
            counts.pruned += (r && r.pruned) || 0;
            // push.js returns skipped as a STRING reason (or null); count it as
            // a skip when the send didn't land (no subs / VAPID unset / etc).
            if (r && r.skipped) counts.skipped += 1;
          } catch (e) {
            // Best-effort: a single failed send never fails the event.
            counts.skipped += 1;
          }
        } else if (channel === "email") {
          // v1: no event declares email, so this branch is unreachable in
          // production. The seam is here so a future event that declares email
          // (and only when isEmailConfigured()) sends through api/_lib/email.js
          // — never a fake send. Left unimplemented deliberately; routeEvent
          // already drops the email channel when email is unconfigured.
          counts.skipped += 1;
        }
      }
    }
  } catch (e) {
    // The engine itself must never throw into a business flow.
    console.error("notify: unexpected error", e && e.message);
  }
  return counts;
}

module.exports = { notify, REGISTRY, getEventDef };
