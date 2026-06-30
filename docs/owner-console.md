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

> First slice. This is a deliberately small, honest, **read-only** first
> version. It surfaces the real signals that exist today and labels the gaps
> plainly; it does not invent telemetry or controls. The follow-ups at the end
> deepen it.

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

## Owner identity — env-only principal (#760)

The recommended owner identity is **not a `users.json` employee at all** — it is a
**synthetic principal** authenticated against env credentials, so it leaves **zero
trace** in the admin Employees view (roster, exports, assignment pickers).

- **Login.** `POST /api/auth?action=login` with the owner username + secret. The
  effective password hash is `resolveOwnerPasswordHash()` = the `owner-auth.json`
  blob (if the owner has set one) **else** the `OWNER_PASSWORD_HASH` env bootstrap.
  The secret is bcrypt-compared and a session is minted for the reserved id
  **`__owner__`** with role `owner`. **Fail closed:** with neither blob nor env hash,
  owner login does not exist (the password *never* defaults). Throttled like any login.
- **Change password (in the console).** `/owner` shows an "Owner password" card →
  `POST /api/auth?action=change-password`. For the `__owner__` principal it verifies
  the current password against the effective hash, then writes the new bcrypt hash to
  the **`owner-auth.json`** blob (runtime-mutable) — so the owner rotates their
  password from the console with **no env edit or redeploy**; the blob hash wins
  thereafter. `OWNER_PASSWORD_HASH` env stays the one-time bootstrap. (Single key,
  shared across environments on a shared Blob store — single-owner by design.)
- **Resolution.** `getCurrentUser` (`api/_lib/auth.js`) short-circuits the
  `__owner__` session to a synthetic owner (`role: 'owner'`, `email: OWNER_EMAILS[0]`,
  `assignedJobIds: []`) **without** reading `users.json`. The HMAC-signed cookie is
  the integrity anchor — a forged `__owner__` cookie is impossible without
  `SESSION_SECRET` (the same trust model as the role claim).
- **Reserved + uncreatable.** Role `owner` is not in `VALID_ROLES` (no owner
  employee can be created); the owner username is rejected on every create/rename
  path in `api/users.js`; and the `users.json` write-guard rejects any row claiming
  the `__owner__` id — so "no trace" can't be undone or the username shadowed.
- **Super-admin.** `owner` ∈ the admin tier, so the synthetic owner passes
  `requireAuth` / `canManageJob` as a full admin (intended — the platform owner is
  the top super-admin), and `canAccessOwnerConsole` is true so the #760 owner-preview
  branch fires.

**Env (Vercel):** `OWNER_LOGIN_USERNAME` (default `owner`), `OWNER_PASSWORD_HASH`
(bcrypt hash — the one-time **bootstrap**; no default → no login until set; once the
owner changes it in the console the `owner-auth.json` blob wins), and the existing
`OWNER_EMAILS`. Generate the bootstrap hash locally:
`node -e "console.log(require('bcryptjs').hashSync('YOUR_PW', 12))"`. The legacy
access paths (a real account with stored role `owner`, or an `OWNER_EMAILS` email on
a real account) still satisfy the console gate, but the env-only principal is the
no-trace path.

## Data sources & honesty

Every value is either **real** (from a live source) or an explicit
**"not instrumented yet"** label. No fake metrics, no invented zeros, no
hardcoded "healthy" (P7 — no fake UI / no invented numbers).

| Panel | Source | Real today? |
| --- | --- | --- |
| **Product health** | Live probes at load: Blob reachability, `SESSION_SECRET` configured, feature-flag expiry. | ✅ derived from real checks |
| **Usage & activity** | Derived from the audit journal (`audit/<yyyy-mm>.json`): events (7d), distinct actors (7d), this month's count, top actions. | ✅ real (business actions only) |
| **Feature flags** | The flag registry (`api/_lib/feature-flags.js`) + env (`FLAG_*`) + the `flags.json` override blob: per-flag resolved state, source, target, expiry classification, protected marker. | ✅ real, **read-only** |
| **Product problems** | Derived from real signals: expired/expiring flags, failed health probes, instrumentation gaps, owner-access durability. | ✅ derived; gaps labelled |
| **Audit trail** | The cross-job audit journal (recent entries; **no metadata payloads**, no ids). | ✅ real |
| **Surface coverage** | `routeExists`/`accessGuarded` from the route map; `auditTracked` **derived** from the live audit-action registry; usage/error columns honestly "not instrumented". | ✅ partial; gaps labelled |
| **Next actions** | Generated from the findings above. | ✅ derived |

**Not instrumented yet (labelled as such, never faked):** route/page views,
feature adoption, login/session activity, error/failed-action telemetry,
endpoint latency, uptime probe.

## Feature flags — read-only

The console **displays** flag state but does **not** toggle anything.

- It shows, per flag: resolved on/off, the resolution **source** (env override >
  blob override > registry default — env always wins), target tier, **expiry
  status** (ok / expiring soon / expired), and a **protected** marker on the
  data-plane / perf flags (`supabase_*`, `phil_jobs_summary_read`).
- There is **no toggle**. No safe runtime override write-path exists yet: there
  is no audited, CAS-guarded, protected-flag-aware writer for `flags.json`, and
  the dangerous Supabase cutover flags must never be flipped from a UI mid-sync.
  Building that writer is a documented follow-up.
- To change a flag today: set `FLAG_<KEY>` in the Vercel env (and redeploy), per
  `docs/feature-flags.md`.

## What is intentionally NOT built (yet)

- **No flag toggles** — read-only (above).
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
- `GET` only (no mutation via this endpoint); a non-`GET` is `405`.
- No client-only access control; no "temporary open route".

## How to verify

Unit (runs in `npm run test:unit`, no browser/credentials):

- `src/domains/platform/owner-console-api.test.ts` — the access gate (`401`
  anon, `403` field/client/**non-owner admin**, `200` owner-role + email-
  allowlist), no-secrets, read-only flags, derived coverage.
- `src/lib/auth/owner-access.test.ts` — `isOwnerRole` + `canAccessOwnerConsole`
  TS↔CJS parity, the email allowlist + `OWNER_EMAILS` override.
- `src/lib/auth/landing.test.ts` — `owner` → `/owner`, other admin roles → `/command-centre`.
- `src/domains/platform/owner-console.test.ts` — classification helpers + schema.
- `src/components/admin/OwnerConsole.render.test.tsx` — panels paint, honest
  empty states, read-only flags.

Live: the page's data comes from `api/owner.js`, which **does not run under
`next dev`** — verify the rendered console on a **PR preview** deploy (sign in as
the owner; confirm a normal admin gets a `404`).

## Follow-ups

1. **Owner-safe runtime feature-flag override API** — audited (new
   `feature_flag.toggled` action), CAS-guarded (`expectedRev`), protected-flag
   aware. Only then add toggles to the console.
2. **Route / feature usage instrumentation** — so the console can answer
   "what's used / abandoned / dead".
3. **Failed-action / error telemetry** — a persisted error feed.
4. **Login / session activity** in the canonical audit journal.
5. **Owner role hardening** — assign a `users.json` account the `owner` role
   and/or configure `OWNER_EMAILS`, to move off the bootstrap default.
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
