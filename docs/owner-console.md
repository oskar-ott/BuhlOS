# Owner Console (Platform Control)

The **Owner Console** at **`/owner`** is the product/platform-owner control
surface for BuhlOS — a private, owner-only view of how the whole product is
doing: app health, what's being used, feature-flag state, product risk, the
audit trail, and what to fix next.

It is **not** the business *owner numbers* dashboard (`/reports`,
`docs/owner-dashboard.md`) — that surface answers "how is the *business*
trending" (hours, approvals, defects, quotes, jobs over contract) for the whole
admin tier. The Owner Console answers "is the *platform* healthy, what's used,
what's broken or uninstrumented, and what's risky" for the **person who runs the
product**. Keep the two separate: business *numbers* vs platform *observability*.

> Honest by construction. Every panel surfaces real signals that exist today and
> labels the gaps plainly; it never invents telemetry. The observability panels
> are read-only; the **feature-flag panel is a live control** (#760) — see
> [Feature-flag control](#feature-flag-control-760). The follow-ups at the end
> deepen the rest.

## Who can access it

Owner-only — **narrower than the admin tier**. Access is granted by EITHER:

1. a stored **`owner` role** (`owner` is already a member of the admin tier in
   `src/lib/auth/roles.ts`; the console gives that role a real surface), **or**
2. an email on the **`OWNER_EMAILS`** allowlist — a comma-separated env var that
   defaults to `oskaott@gmail.com` (the product owner) so the console is
   reachable out-of-the-box. Rotate it via the env var, no code change.

Everyone else — field workers, clients, **and normal admin-tier users
(boss / manager / office / pm / estimator)** — cannot access it. A normal admin
who navigates to `/owner` gets a `404` (the console's existence is not
revealed). It is **not** in the shared admin sidebar.

The owner reaches it two ways:

- **Login landing** — a user whose stored role is `owner` lands on `/owner`
  after sign-in (`landingFor('owner')` → `/owner`; `docs/route-ownership.md` §10).
- **Direct URL** — `/owner`. Email-allowlist owners (whose stored role is
  `admin`) use this, because the session cookie carries no email to auto-route on.

## Access model (defence in depth)

The session cookie (`buhl_session`) carries only `{ userId, role }` — **no
email** — and the middleware decodes it without HMAC verification (that's the
API's job). So the owner gate is layered:

| Layer | What it does | Why |
| --- | --- | --- |
| **Middleware** (`src/middleware.ts`) | Coarse-gates `/owner` to the **admin tier** (`surface: 'admin'`). Unauthenticated → `307 /v2/login?next=/owner`; non-admin (field/client) → `307` to their landing. | The decoded cookie has no email, so middleware can't do the owner-only narrowing — it just keeps non-admins out. |
| **API** (`api/owner.js`) | The **authoritative** owner gate. `requireAuth` HMAC-verifies the session and loads the **fresh** user from `users.json`; then `canAccessOwnerConsole(user)` requires the `owner` role **or** an `OWNER_EMAILS` email. **Fails closed**: `401` anon, `403` non-owner. | The fresh user has the email; HMAC-verification means a forged cookie can't claim `owner`. This is the real security boundary. |
| **Page** (`src/app/(admin)/owner/page.tsx`) | Fetches `/api/owner` server-side with the cookie. `403` → `notFound()` (hide the console). `200` → render. The endpoint **is** the data source, so the gate and the data can never disagree. | A non-owner never sees the console chrome or any data; a forged-cookie attacker gets the shell at most but `403`/no data. |

Because the data flows only through the owner-gated API, there is **no
client-only protection** of anything sensitive.

## Data sources & honesty

Every value is either **real** (from a live source) or an explicit
**"not instrumented yet"** label. No fake metrics, no invented zeros, no
hardcoded "healthy" (P7 — no fake UI / no invented numbers).

| Panel | Source | Real today? |
| --- | --- | --- |
| **Product health** | Live probes at load: Blob reachability, `SESSION_SECRET` configured, feature-flag expiry. | ✅ derived from real checks |
| **Usage & activity** | Derived from the audit journal (`audit/<yyyy-mm>.json`): events (7d), distinct actors (7d), this month's count, top actions. | ✅ real (business actions only) |
| **Feature flags** | The flag registry (`api/_lib/feature-flags.js`) + env (`FLAG_*`) + the `flags.json` override blob: per-flag resolved state, source, target, expiry classification, protected marker. | ✅ real, **live control** (#760) |
| **Product problems** | Derived from real signals: expired/expiring flags, failed health probes, instrumentation gaps, owner-access durability. | ✅ derived; gaps labelled |
| **Audit trail** | The cross-job audit journal (recent entries; **no metadata payloads**, no ids). | ✅ real |
| **Surface coverage** | `routeExists`/`accessGuarded` from the route map; `auditTracked` **derived** from the live audit-action registry; usage/error columns honestly "not instrumented". | ✅ partial; gaps labelled |
| **Next actions** | Generated from the findings above. | ✅ derived |

**Not instrumented yet (labelled as such, never faked):** route/page views,
feature adoption, login/session activity, error/failed-action telemetry,
endpoint latency, uptime probe.

## Feature control (the feature board)

The console **controls** feature visibility (it is no longer read-only). The
flags are presented as a **feature board** — grouped by domain (QA & compliance,
Site records, Commercial, …), each feature a row with a human label and a state
chip (**On** / **Preview only** / **Off** / **Pinned by env**). Each
non-protected flag has two dials — **Live to customers** (the customer launch
gate) and **Preview for me** (an owner-only override) — while protected
data-plane flags (`supabase_*`, `phil_jobs_summary_read`) are fenced in a
collapsed read-only **System · data-plane** group, and env (`FLAG_*`) always
wins. Full mechanics, precedence and safety rules:
[Feature-flag control](#feature-flag-control-760). To pin a flag per-environment
regardless of the UI, set `FLAG_<KEY>` in the Vercel env per
`docs/feature-flags.md`.

## What is intentionally NOT built (yet)

- **No route/feature usage instrumentation** — no analytics store exists; the
  console labels this gap and proposes it as a follow-up.
- **No error/failed-action telemetry**, **no login/session log**, **no latency
  or uptime metrics** — all labelled "not instrumented yet".
- **No new role literal, no new flag system, no new audit architecture** — the
  console reuses the existing role taxonomy, flag registry, and audit journal.

## Security rules (enforced)

- Server-side gate at the API on **every** request; **fails closed**.
- Never returns: `SESSION_SECRET` (only a configured/not boolean), password
  hashes, raw env, the raw `flags.json` blob, audit metadata payloads, or the
  full user table. The viewer's own email is **masked**.
- `api/owner.js` is `GET` only (no mutation; non-`GET` is `405`). The one write
  surface is the companion `api/owner-flags.js` (`POST`), which reuses the
  **identical** owner gate (`requireAuth` + `canAccessOwnerConsole`, fails
  closed) and is CAS-guarded + audited — see
  [Feature-flag control](#feature-flag-control-760).
- No client-only access control; no "temporary open route".

## Feature-flag control (#760)

The feature-flag panel is a **live control surface**: the owner switches
unfinished features off for customers at launch and still previews them in the
real product. Each non-protected flag has **two dials**:

- **Live to customers** — the launch gate (the `flags.json` `flags[key]`
  baseline; what everyone sees).
- **Preview for me** — an **owner-only** override (`flags.json`
  `ownerPreview[key]`) layered on top, so the owner runs a feature live while
  customers still can't see it.

**Staged rollout — the easy control.** Each product feature has one segmented
control: **Off** (hidden from everyone) → **Preview** (only the owner sees it —
build and test it live in the real product) → **Live** (everyone). This is the
honest single-control expression of the two dials, written atomically via
`POST /api/owner-flags { key, rollout: "off"|"preview"|"live", expectedRev }`
(one CAS write + one `feature_flag.toggled` audit). When a feature is reachable
for the owner (Preview or Live) an **"Open to test"** link deep-links straight
to it (`FLAG_PRESENTATION[key].previewHref` — job-scoped features point at
`/v2/jobs`), so the owner can try a disabled feature before releasing it to
customers or admins. Moving a **live** feature back (to Preview or Off) goes
through the reduce-exposure confirm; releasing forward is one click. The
underlying two-dial scope writes (`scope`/`value`) remain for advanced use.

**The board** (`OwnerFeatureBoard`) frames the raw flags as features:

- **Domain groups.** Non-protected flags carry presentation metadata
  (`label`, `domain`, `surface`) in `FLAG_PRESENTATION`
  (`api/_lib/feature-flags.js`); the board groups rows by `domain` and labels
  them by `label` (e.g. `itp` → "ITPs", `rfi_register` → "RFIs"). A flag with no
  presentation metadata is a data-plane flag and lands in the read-only
  **System · data-plane** group.
- **Filters.** Exposure (All / On / Preview / Off) and surface
  (All / BuhlOS / Phil), with live counts — the honest replacement for the
  prototype's fake multi-tenant matrix.
- **Reduce-exposure confirm.** Turning a customer-visible feature **off**
  (reducing exposure) opens a small confirm step with an optional **reason**;
  the reason is threaded into the `feature_flag.toggled` audit `metadata`.
  *Enabling* a feature is one click (no confirm).
- **Kill-switch features.** A live-by-default feature (`killSwitch: true`, e.g.
  `itp`) shows **On** out of the box; the owner uses *Live to customers* to turn
  it **off**. See `docs/feature-flags.md` → Two flag kinds.
- **Whole-interface control.** Most shipped features are kill-switches — jobs,
  hours, evidence, observations, material requests, expenses, quotes, defects,
  dayworks, employees, gear, reports, ITPs, RFIs, snags, photos, scope, job
  control, closeout, documents, circuit schedules, diary, activity, and more.
  Turning one off hides its **nav entry, job-hub section and Command Centre
  card**, `404`s its **routes**, and `404`s its **API** — the feature is gone,
  not just hidden. See `docs/feature-flags.md` → Feature kill-switches.
- **Core warning.** `jobs`, `hours` and `evidence` are marked **core**
  (`core: true`); the reduce-exposure confirm shows a prominent warning before
  the owner disables a load-bearing surface. `Command centre` and `/owner`
  itself are never gateable, so the owner can't lock themselves out.

**Resolution precedence** (`isFlagEnabled(key, viewer)` in
`api/_lib/feature-flags.js`): `env (FLAG_*) > owner-preview (owner viewer only) >
customer baseline (blob → registry default)`, then admin-tier targeting. The
data-plane path (`isFlagOn` / `isFlagOnSync`, no viewer) is **unchanged** and
never reads `ownerPreview`, so owner preview can't alter request-time data
behaviour.

**Write path** — `POST /api/owner-flags` `{ key, scope, value, expectedRev }`
(`scope` = `customer` | `ownerPreview`; `value` = `true`/`false`, or `null` to
clear). Owner-gated (same boundary as the read endpoint, fails closed),
registry-validated, CAS-guarded (`expectedRev` on `flags.json`), and audited
(`feature_flag.toggled`, best-effort). Toggles are optimistic in the UI and roll
back with a visible error on failure.

**Rules & constraints (deliberate):**

- **Protected data-plane flags** (`supabase_*`, `phil_jobs_summary_read`) are
  **never** toggleable here (`isProtectedFlag` → `409`); they're ops levers, set
  via env. The console renders them read-only.
- **Env always wins.** A flag pinned by a `FLAG_*` env var can't be changed from
  the console; the row shows disabled with a "pinned by env" note.
- **Owner-role precondition.** *Preview for me* only takes effect **in the live
  app** when the owner's account has the stored **`owner` role** — RSC/API
  viewers carry role but no email, so the `OWNER_EMAILS` path can't drive in-app
  preview. When access is via the email allowlist the panel shows a banner saying
  so. The *customer* toggle works regardless. (See follow-up: owner-role
  hardening.)
- **Shared blob + ~5s cache.** `flags.json` is one Blob object; a toggle applies
  to any environment sharing that store and converges within ~5s (the `readBlob`
  TTL). Use per-environment `FLAG_*` env vars for true per-env pinning.
- **Expiry discipline.** Registry flags carry an `expires` date (CI-enforced).
  Using a flag as a long-lived launch gate means consciously extending that date;
  the console surfaces expiring/expired flags so it stays visible.

## How to verify

Unit (runs in `npm run test:unit`, no browser/credentials):

- `src/domains/platform/owner-console-api.test.ts` — the access gate (`401`
  anon, `403` field/client/**non-owner admin**, `200` owner-role + email-
  allowlist), no-secrets, `toggleable`/protected projection, **plus the
  `POST /api/owner-flags` write path** (same gate; unknown-key/bad-scope/bad-value
  `400`; protected `409` + blob untouched; customer & owner-preview happy paths;
  `value:null` clear; CAS stale `409`; audit emitted; audit-failure tolerated).
- `src/domains/flags/feature-flags.test.ts` — owner-preview resolution
  (overrides baseline for the owner only; env beats preview; non-owner never
  reads it; `isFlagOn`/`isFlagOnSync` ignore it; admin-tier composition) +
  `isProtectedFlag`.
- `src/lib/auth/owner-access.test.ts` — `isOwnerRole` + `canAccessOwnerConsole`
  TS↔CJS parity, the email allowlist + `OWNER_EMAILS` override.
- `src/lib/auth/landing.test.ts` — `owner` → `/owner`, other admin roles → `/command-centre`.
- `src/domains/platform/owner-console.test.ts` — classification helpers + schema.
- `src/components/admin/OwnerConsole.render.test.tsx` — panels paint, honest
  empty states, the read-only fallback, and the interactive flag controls
  (switches render; protected + env-pinned fenced).

Live: the page's data comes from `api/owner.js` (and writes go to
`api/owner-flags.js`), which **do not run under `next dev`** — verify on a **PR
preview** deploy: sign in as the owner; confirm a normal admin gets a `404`;
switch a feature **off for customers** and confirm a second (non-owner) session
can't see it; turn **Preview for me** on and confirm it shows only to the owner;
confirm a protected flag has no toggle.

## Shipped

- **Owner-safe runtime feature-flag override API (#760)** — `POST
  /api/owner-flags`, audited (`feature_flag.toggled`), CAS-guarded
  (`expectedRev`), protected-flag aware, with the two-dial (customer + owner
  preview) model. See [Feature-flag control](#feature-flag-control-760).

## Follow-ups

1. **Route / feature usage instrumentation** — so the console can answer
   "what's used / abandoned / dead".
2. **Failed-action / error telemetry** — a persisted error feed.
3. **Login / session activity** in the canonical audit journal.
4. **Owner role hardening** — assign a `users.json` account the `owner` role
   (not just the `OWNER_EMAILS` bootstrap). Beyond moving off the default, this
   is the **precondition for in-app *Preview for me***: RSC/API flag resolution
   sees the role, not the email, so owner preview only takes effect once the
   account's stored role is `owner`.
5. **Per-feature config knobs (PR 2)** — tune real feature settings (upload
   caps, length limits, windows) from the console, on top of the visibility
   dials. A settings registry + `feature-settings.json` + `getSetting` resolver +
   owner-gated write.
6. **Preview/prod health summary** — wire the dark `supabase_read_health` probe
   and surface build/version metadata.

## Wiki sync

Per `docs/wiki-sync.md`, after this merges, sync the GitHub Wiki: add `/owner`
to the **Admin / Boss Interface** page and note the Owner Console pattern on the
**BuhlOS Constitution / Decision Log** page, stamped with the merge commit.

## Cross-references

- Route contract: `docs/route-ownership.md` §4, §8, §8.1, §10.
- Roles: `docs/roles.md`. Flags: `docs/feature-flags.md`.
- Business owner numbers (distinct surface): `docs/owner-dashboard.md`.
