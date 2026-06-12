/**
 * The `NotificationItem` contract (#218, Epic 18) + the canonical pref-key list
 * for the TypeScript surfaces (prefs panel, bell).
 *
 * `NotificationItem` is the typed shape of ONE row in the future notification
 * feed — the data the bell (`src/components/admin/NotificationBell.tsx`) renders
 * and the data a later feed endpoint (#220) will return. It is intentionally
 * defined and tested BEFORE that endpoint exists so the bell can be built and
 * render-tested against fixtures without dead chrome in the app.
 *
 * Source-of-truth note: the RUNTIME engine + router live in CJS
 * (`api/_lib/notify-routing.js`, `api/_lib/notify.js`) because the serverless
 * functions can't import `.ts` at runtime. This file owns the pref-key list for
 * the TS world; `notification-item.test.ts` proves it stays 1:1 with the CJS
 * router's `PREF_KEYS` AND the prefs endpoint's `VALID_KEYS`, so the three can
 * never drift.
 *
 * Design pins (issue #218 ACs):
 *   - `kind` is aligned 1:1 with the six notification preference keys (and the
 *     engine's registry kinds). Adding a sender kind without a pref toggle (or
 *     vice versa) fails CI.
 *   - `deepLink` is a MODERN-route path (`/phil/my-day`, `/command-centre`,
 *     `/v2/jobs/<id>#…`). The CURRENT push payloads still carry some legacy
 *     URLs; `docs/notifications.md` records that the Epic 18 engine must emit
 *     modern targets when it adopts this contract — never a legacy static-HTML
 *     page or a deleted legacy module route.
 *   - the feed is viewer-scoped (an office bell shows office-tier kinds only) —
 *     the bell takes its items as input and never fetches a global feed.
 */

/** The six documented preference keys, 1:1 with `api/notification-prefs.js`
 *  `VALID_KEYS` and `api/_lib/notify-routing.js` `PREF_KEYS`. */
export const NOTIFICATION_PREF_KEYS = [
  "hoursApproved",
  "snagAssigned",
  "dailyHoursReminder",
  "dailyDigest",
  "staleSnags",
  "tagReminders",
] as const;

export type NotificationPrefKey = (typeof NOTIFICATION_PREF_KEYS)[number];

/**
 * The kinds a feed row can carry. Aligned 1:1 with the six pref keys today; the
 * union is open to ADDITIVE kinds in future (e.g. an `alwaysOn` event like
 * `hoursRejected` could surface here without a pref toggle) — the 1:1 test
 * covers the pref-backed kinds, not a closed-world assertion.
 */
export type NotificationKind = NotificationPrefKey;

/** The six pref-backed kinds, re-exported so the bell + tests have one import
 *  site for the canonical list. */
export const NOTIFICATION_ITEM_KINDS: ReadonlyArray<NotificationKind> =
  NOTIFICATION_PREF_KEYS;

export interface NotificationItem {
  /** Stable unique id for the row (de-dupe + mark-read target). */
  readonly id: string;
  /** Which event produced this row. Drives the icon + grouping in the bell. */
  readonly kind: NotificationKind;
  /** One-line human title, e.g. "Hours approved". */
  readonly title: string;
  /**
   * Where tapping the row should land — a MODERN in-app route path. Optional:
   * a purely informational row may have no destination.
   */
  readonly deepLink?: string;
  /** ISO-8601 timestamp of when the underlying event occurred. */
  readonly occurredAt: string;
  /**
   * ISO-8601 timestamp of when the viewer read this row, or `null`/absent when
   * still unread. Unread rows drive the bell's badge count.
   */
  readonly readAt?: string | null;
}

/** A row is unread when it has no `readAt`. Centralised so the bell and any
 *  future feed endpoint agree on the definition of "unread". */
export function isUnread(item: NotificationItem): boolean {
  return item.readAt == null;
}

/** Count of unread rows in a feed — the bell's badge number. */
export function unreadCount(items: ReadonlyArray<NotificationItem>): number {
  let n = 0;
  for (const it of items) if (isUnread(it)) n++;
  return n;
}
