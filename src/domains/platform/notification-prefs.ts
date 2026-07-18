import { z } from "zod";
import { NOTIFICATION_PREF_KEYS, type NotificationPrefKey } from "./notification-item";

/**
 * Client contract for the notification preferences panel (#218).
 *
 * Surface-agnostic on purpose: `GET`/`PUT /api/notification-prefs` is self-only
 * and serves field users too (Phil may grow the same toggles later), so this
 * domain client carries no admin assumptions — the PANEL placement is the
 * admin shell's choice, not this module's.
 *
 * The server (`api/notification-prefs.js`) returns every key resolved to a
 * boolean (missing → true). We still parse through a tolerant schema so a
 * partial/absent payload defaults to true CLIENT-side too — a unit test pins
 * that, so the UI can never show "off" for a pref the server treats as on.
 */

/** Per-key plain-English copy for the panel — label + a one-line description
 *  that names WHO receives it (issue #218 AC: no bare key names). Recipient
 *  phrasing is tier-aware (PR #354 made the cron fan-outs tier-aware). */
export interface NotificationPrefMeta {
  readonly key: NotificationPrefKey;
  readonly label: string;
  readonly description: string;
}

export const NOTIFICATION_PREF_META: ReadonlyArray<NotificationPrefMeta> = [
  {
    key: "hoursApproved",
    label: "Hours approved",
    description: "A ping when your submitted hours are signed off. Sent to the worker whose hours were approved.",
  },
  {
    key: "snagAssigned",
    label: "Snag assigned to you",
    description: "When a defect is assigned to you. Sent to the field worker or leading hand it lands on.",
  },
  {
    key: "dailyHoursReminder",
    label: "Daily hours reminder",
    description: "An afternoon nudge if you haven't logged hours yet. Sent to crew and leading hands.",
  },
  {
    key: "dailyDigest",
    label: "End-of-day digest",
    description: "A 5pm summary of the day's activity. Sent to office and management.",
  },
  {
    key: "staleSnags",
    label: "Stale-snag triage",
    description: "A Monday-morning roll-up of defects going cold. Sent to office and management.",
  },
  {
    key: "tagReminders",
    label: "Test & tag reminders",
    description: "When test tags or calibrations are coming due. Sent to office, leading hands and whoever holds the instrument.",
  },
];

/** All-keys-required, all-boolean, all-default-true. The server always sends a
 *  fully-resolved object; the defaults make the client robust to a partial or
 *  empty payload (and to a future additive key the server hasn't sent yet). */
export const NotificationPrefsSchema = z.object(
  Object.fromEntries(
    NOTIFICATION_PREF_KEYS.map((k) => [k, z.boolean().default(true)]),
  ) as Record<NotificationPrefKey, z.ZodDefault<z.ZodBoolean>>,
);

export type NotificationPrefs = Record<NotificationPrefKey, boolean>;

/** The `GET`/`PUT` response envelope: `{ prefs, role }`. `prefs` is tolerant;
 *  extra/unknown keys on the object are ignored (zod object strips them). */
export const NotificationPrefsResponseSchema = z.object({
  prefs: NotificationPrefsSchema,
  role: z.string().optional(),
});

export type NotificationPrefsResponse = z.infer<typeof NotificationPrefsResponseSchema>;

/**
 * Parse a raw `GET`/`PUT` body into a fully-defaulted prefs object. Missing
 * keys (and a missing/!object `prefs`) resolve to all-true — the same default
 * the server applies. Returns `null` only when the payload is unusable in a way
 * the defaults can't cover (e.g. a non-object), so the caller can show an
 * error state rather than a silently-wrong panel.
 */
export function parsePrefsResponse(raw: unknown): NotificationPrefs | null {
  const withPrefs =
    raw && typeof raw === "object" && "prefs" in (raw as Record<string, unknown>)
      ? raw
      : { prefs: raw ?? {} };
  const parsed = NotificationPrefsResponseSchema.safeParse(withPrefs);
  if (!parsed.success) return null;
  return parsed.data.prefs;
}

/** All-true default — the starting/fallback state before a successful load. */
export function defaultPrefs(): NotificationPrefs {
  return Object.fromEntries(
    NOTIFICATION_PREF_KEYS.map((k) => [k, true]),
  ) as NotificationPrefs;
}

/**
 * Pure toggle/rollback state machine for the panel (#218). Extracted so the
 * optimistic-flip-then-rollback behaviour is unit-testable without a DOM (the
 * repo's vitest runs in the node env — no jsdom). The component is a thin shell
 * over these transitions.
 *
 *   - `optimisticToggle(prefs, key)` flips one key (the value shown the instant
 *     the user taps).
 *   - `rollback(prefs, key, previous)` restores a key after a failed PUT.
 *   - `applyServerEcho(prefs, server)` trusts the server's resolved object after
 *     a successful PUT (so two-tab drift converges).
 */
export function optimisticToggle(
  prefs: NotificationPrefs,
  key: NotificationPrefKey,
): NotificationPrefs {
  return { ...prefs, [key]: !prefs[key] };
}

export function rollback(
  prefs: NotificationPrefs,
  key: NotificationPrefKey,
  previous: boolean,
): NotificationPrefs {
  return { ...prefs, [key]: previous };
}

export function applyServerEcho(
  prefs: NotificationPrefs,
  server: NotificationPrefs | null,
): NotificationPrefs {
  return server ?? prefs;
}
