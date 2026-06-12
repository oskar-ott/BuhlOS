# Notifications — engine, prefs + the feed contract

> Status: **living doc** · Owners: platform (#162 engine) + admin-ui (#218 prefs
> panel + bell). One doc, both issues reference it.
>
> - Engine runtime: `api/_lib/notify.js` + the pure router `api/_lib/notify-routing.js`
> - Prefs store + endpoint: `api/notification-prefs.js` (`GET`/`PUT`, self-only)
> - Feed contract + TS pref-key list: `src/domains/platform/notification-item.ts`
> - Prefs panel: `src/app/(admin)/settings/notifications/page.tsx`
> - Bell (built, **not mounted**): `src/components/admin/NotificationBell.tsx`

## 1. Why this exists

Before the `notify()` engine, every push was a direct `sendPushToUserId(...)`
call scattered across ~14 serverless handlers, and **none of them consulted the
user's `notificationPrefs`**. The prefs panel (#218) therefore rendered honest-
looking toggles that did nothing — a user could switch `hoursApproved` off and
still receive the approval push. That is a fake-UI-from-inside-the-platform
violation of the hide-unfinished rule.

`notify()` (#162) is the single seam every notification flows through. It
resolves an event's audience, applies each recipient's per-type prefs through a
pure router, and delivers on the event's declared channels via the existing
push (and, later, email) libraries. Making prefs *real* is the engine's job;
exposing them is the panel's. The two ship together because the UI alone would
just amplify dead toggles.

## 2. The six preference keys

These are the canonical keys, defined in **three places that a test keeps 1:1**
(`src/domains/platform/notification-item.test.ts`):

- `api/notification-prefs.js` `VALID_KEYS` — the store + endpoint validation,
- `api/_lib/notify-routing.js` `PREF_KEYS` — the runtime router,
- `src/domains/platform/notification-item.ts` `NOTIFICATION_PREF_KEYS` — the TS
  surfaces (prefs panel, bell, feed contract).

| Key | Plain-English label (prefs panel) | Who receives it |
| --- | --- | --- |
| `hoursApproved` | **Hours approved** — a ping when your submitted hours are signed off | the worker whose hours were approved (field / LH) |
| `snagAssigned` | **Snag assigned to you** — when a defect is assigned to you | the field / LH user a snag is assigned to |
| `dailyHoursReminder` | **Daily hours reminder** — an afternoon nudge if you haven't logged hours | field + LH who haven't logged hours today |
| `dailyDigest` | **End-of-day digest** — a 5pm summary of the day's hours and snags | admin-tier users with a push subscription |
| `staleSnags` | **Stale-snag triage** — a Monday-morning roll-up of defects going cold | admin-tier users with a push subscription |
| `tagReminders` | **Test & tag reminders** — when test tags or calibrations are due | admins (all jobs) + LH (their jobs) + instrument holders |

**Default:** every key is **ON** when absent. A missing key — and a missing
`notificationPrefs` object entirely — both mean "deliver" (preserved exactly
from `api/notification-prefs.js`). A user who has never opened the panel
notices zero change.

> Recipient eligibility note (was a known limitation, now resolved): the digest
> and tag-reminder cron fan-outs are tier-aware (`isAdminRole`/`isStaffRole`,
> PR #354) — boss/owner/office-tier admins are eligible, not just the literal
> `admin` role. The "who receives it" column above is therefore honest for the
> whole admin tier, and the panel describes recipients tier-aware.

## 3. Event registry (kind → audience → channels)

`api/_lib/notify.js` `REGISTRY` declares exactly the six kinds. Each event sets
**either** a `prefKey` (the gating preference) **or** `alwaysOn: true` (ignore
prefs — see §4). v1 channels are **push-only** for every event.

| Kind | `prefKey` | `alwaysOn` | Channels | Audience resolution |
| --- | --- | --- | --- | --- |
| `hoursApproved` | `hoursApproved` | — | `["push"]` | caller passes the approved worker's record |
| `snagAssigned` | `snagAssigned` | — | `["push"]` | caller passes the assignee's record |
| `dailyHoursReminder` | `dailyHoursReminder` | — | `["push"]` | cron: field + LH who haven't logged today |
| `dailyDigest` | `dailyDigest` | — | `["push"]` | cron: admin-tier subscribers |
| `staleSnags` | `staleSnags` | — | `["push"]` | cron: admin-tier subscribers |
| `tagReminders` | `tagReminders` | — | `["push"]` | cron: admins + LH + instrument holders |

Audience is **resolved by the caller** (a single-recipient handler already knows
its recipient; a cron passes its filtered user list). The engine does not
re-resolve — it applies prefs to the audience it is given.

## 4. The `alwaysOn` class (a deliberate, reserved decision)

Several **live** pushes have no pref key and must NOT get one, because muting
them would break a flow:

- **Hours rejected / reopened** (`api/time-entries-reject.js`, `…-reopen.js`,
  bulk variants) — the worker must notice the rejection or the rejected→resubmit
  loop (`/phil/hours`) silently stalls.
- **Capture-v2 office inbox** (`api/observations.js`, "Send to the office") — a
  muted office push means a lost site photo.
- **Cash-watch overruns** (`api/cash-watch.js`) and **payroll reminders**
  (`api/payroll-reminder.js`) — owner-critical signal.

The router supports an `alwaysOn: true` event class (built + unit-tested now)
that **bypasses the pref gate entirely**. When those call-sites are migrated
(see §6 follow-ups) they register as `alwaysOn` events with `prefKey: null` —
**never** as new pref keys the panel doesn't render. None of the six current
registry events are `alwaysOn`; the class exists so that migration is a registry
addition, not a redesign.

## 5. Channels + the email seam (never a fake send)

- v1 is **push-only**. Every registry event declares `channels: ["push"]`.
- The router knows an `"email"` channel and the engine has an email-delivery
  branch, but the email leg is offered **only** when an event declares `email`
  **and** `isEmailConfigured()` is true (`api/_lib/email.js`). No event declares
  email today, so nothing ever sends — the seam exists, it never fake-sends.
- SMS (#311), Slack/Teams (#321) and the broader integration framework (#310)
  plug in here later by **adding a channel to the registry**, not by adding
  another scattered `sendPushToUserId` call-site. They should name `notify()` as
  their entry point.
- The Supabase `outbox_events` table (Phase 1 schema, #160/#152) is the v2
  transport: the registry is shaped so delivery can later be *enqueued* rather
  than sent inline. Not built now.

## 6. Adopted call-sites + the migration ledger

`notify()` is adopted with **unchanged audience + content** — every migrated
push reaches the same recipient with the same payload as before; the only new
behaviour is that a muted pref now suppresses that one user. Proven by
fixture-compare in `src/domains/platform/notify-engine-api.test.ts` and by the
unchanged assertions in `src/domains/time-entries/time-entry-actions-api.test.ts`.

**Migrated in this PR (#162):**

| Call-site | Event kind | Notes |
| --- | --- | --- |
| `api/time-entries-approve.js` | `hoursApproved` | recipient record resolved for prefs |
| `api/time-entries-bulk-approve.js` | `hoursApproved` | **per-recipient** prefs, not per-batch |
| `api/snag-quick-raise.js` | `snagAssigned` | auto-assigned LH or explicit assignee |
| `api/snag-notify.js` (`kind: 'assigned'`) | `snagAssigned` | `resolved`/`reopened` stay direct (future `alwaysOn`) |
| `api/notifications.js` → `send-stale-snags` | `staleSnags` | pilot cron; one engine call routes the admin fan-out |

**Tracked follow-ups (left as direct `sendPushToUserId`, to migrate next):**

- Other cron actions in `api/notifications.js`: `send-daily-reminders`
  (`dailyHoursReminder`), `send-daily-digest` (`dailyDigest`),
  `send-tag-reminders` (`tagReminders` — already consults the pref inline),
  `send-licence-reminders`, `send-inactive-users`.
- Hours **rejected/reopened**: `time-entries-reject.js`, `…-reopen.js`,
  `time-entries-bulk-reject.js` → migrate as `alwaysOn` events.
- Office inbox: `api/observations.js` → `alwaysOn`.
- `api/cash-watch.js`, `api/payroll-reminder.js` → `alwaysOn`.
- `api/data.js`, `api/users.js`, `api/plans.js`, `api/assets.js`,
  `api/leave.js` — audit each for the right kind or an explicit "stays direct".
- `api/push-test.js` — **stays direct** by design (a raw-pipe QA tool).

The engine returns aggregated outcome counts `{ sent, pruned, skipped }` per
call (forwarded from `push.js`), preserved/logged at the call-site.

## 7. `NotificationItem` — the future feed contract (#218 / Epic 18)

`src/domains/platform/notification-item.ts` defines the typed shape of one row
in the **future** notification feed — what the bell renders and what a later
feed endpoint (#220) will return. Defined + tested **before** that endpoint
exists so the bell can be built against fixtures without dead chrome.

```ts
interface NotificationItem {
  id: string;            // stable; de-dupe + mark-read target
  kind: NotificationKind; // 1:1 with the six pref keys (additive-open)
  title: string;         // one-line, e.g. "Hours approved"
  deepLink?: string;     // MODERN in-app route (see §8); optional
  occurredAt: string;    // ISO-8601 of the underlying event
  readAt?: string | null; // ISO-8601 when read; null/absent = unread
}
```

- `kind` is aligned **1:1** with the six pref keys (test-enforced). The union is
  open to additive kinds later (e.g. an `alwaysOn` `hoursRejected` could surface
  here without a pref toggle).
- The feed is **viewer-scoped** — an office bell shows office-tier kinds only.
  The bell takes its items as **input**; it never fetches a global all-users
  feed.
- `isUnread(item)` / `unreadCount(items)` are the canonical badge helpers.

## 8. Deep-link targets must be MODERN routes

The **current** push payloads (in the cron handlers) still carry some legacy
URLs as historical deep-links (`/overview`, `/jobs/<id>#tags`, `/my-day`). Those
predate the legacy cutover and are individually fine because every legacy URL
`307`-redirects.

**The `NotificationItem.deepLink` contract mandates modern-route targets** —
`/phil/my-day`, `/command-centre`, `/v2/jobs/<id>#…`, never a `*.html` or
`/admin/*` URL. When the Epic 18 engine emits feed rows, it must produce modern
targets, not inherit the legacy ones. Mapping per kind:

| Kind | Modern deep-link target |
| --- | --- |
| `hoursApproved` | `/phil/my-day` |
| `snagAssigned` | `/phil/jobs/<jobId>#phil-job-snags` |
| `dailyHoursReminder` | `/phil/my-day` |
| `dailyDigest` | `/command-centre` |
| `staleSnags` | `/command-centre` |
| `tagReminders` | `/gear` (admin) · `/phil/jobs/<jobId>` or `/phil/gear` (field) |

## 9. The prefs panel + the bell (#218)

- **Prefs panel** — `src/app/(admin)/settings/notifications/page.tsx`, AdminShell
  title "Notification settings". Per-type toggles over the existing
  `GET`/`PUT /api/notification-prefs` (self-only). Optimistic flip with rollback
  **and a visible error chip** on `PUT` failure. Plain-English labels (§2), each
  with a "who receives this" line. Reachable from a small footer link in the
  admin sidebar (near sign-out) — settings is not a daily destination, so it is
  deliberately not a nav-group item. #222 (a future settings hub) absorbs this
  page later.
- **Bell** — `src/components/admin/NotificationBell.tsx`, built + render-tested
  against `NotificationItem` fixtures (unread badge, list, mark read / mark all
  read, deep links, "You're all caught up" empty state, error state). It is
  **NOT mounted anywhere** — no real feed endpoint exists yet, and the
  hide-unfinished rule forbids dead chrome. Mounting is a one-line follow-up when
  Epic 18's feed (#220) lands. A code comment on the component states exactly
  this.

## 10. No websockets / no polling additions

When the bell eventually mounts, it reuses the command-centre polling cadence
(no websockets) — per the route-ownership service-worker contract, push stays
the live transport and the bell is a recovery surface, not a real-time stream.
