# 05 · Auth and permissions audit

The current auth flow, role handling, and route protection — and what the rebuild needs.

---

## Current login surface

| Surface           | File                                | Posts to                          | Method | Status                                                |
| ----------------- | ----------------------------------- | --------------------------------- | ------ | ----------------------------------------------------- |
| `/login`          | `public/login.html`                 | `/api/auth?action=login`          | POST   | ✅ working                                            |
| Phil's in-app login | `public/phil.html#showLoginScreen`  | `/api/auth?action=signin`         | POST   | ❌ broken — endpoint does not exist                  |
| `/logout`         | (any page calls)                    | `/api/auth?action=logout`         | POST   | ✅ working                                            |
| Phil's signout    | `public/phil.html#doSignOut`        | `/api/auth?action=signout`        | POST   | ❌ broken — endpoint does not exist                  |
| `change-password` | `public/admin/settings.html`        | `/api/auth?action=change-password`| POST   | ✅ working                                            |

**Critical bug:** Phil's login + signout use `action=signin` / `action=signout`. The backend (`api/auth.js`) only routes `action=login` / `action=logout`. Phil's login form does nothing and signout 404s silently (caught + ignored). This means Phil is currently un-loggable-into via its own UI — workers must use `/login` and rely on the cookie persisting when they navigate to `/phil`.

---

## Auth mechanism

- **Cookie name:** `buhl_session`
- **Format:** `base64url(JSON payload).hmac` — JWT-style but HMAC-only, no JWT library.
- **Payload:** `{ userId, role, exp }` where `exp` is epoch ms.
- **Secret:** `SESSION_SECRET` env var (≥16 chars enforced by `secret()` throw).
- **Flags:** `httpOnly`, `secure`, `sameSite=lax`, `path=/`, `maxAge = 30 days`.
- **Verification:** timing-safe compare. Exp check on every request.
- **Reads:** `getCurrentUser(req)` re-reads `users.json` from Blob on every request to get fresh role/assignments. The session payload's `role` is a hint, not authoritative.

**Strengths:**
- Stateless. No serverside session store.
- Fresh per-request user lookup catches role changes immediately.
- Timing-safe HMAC compare prevents oracle attacks.

**Concerns:**
- Re-reading `users.json` on every request is fine at small scale but doesn't scale past hundreds of users. Cached lookup acceptable as a future optimisation.
- Cookie name `buhl_session` is fine; no rename needed.
- No CSRF protection. POST endpoints rely on `sameSite=lax` + the fact that they require a session cookie. For a rebuild, add explicit CSRF tokens or use SameSite=strict on the session.
- No refresh-token flow — 30-day cookie just rolls. Acceptable for an internal tool.

---

## Login flow

```
1. User visits /login (or any rewritten root → /login.html).
2. login.html POSTs to /api/auth?action=login with { username, secret }.
3. api/auth.js:
   - Reads users.json from Blob.
   - Finds user by username (case-insensitive).
   - bcrypt.compare(secret, user.passwordHash). Min length: 6 chars (admin) or 4 digits (others).
   - setSessionCookie() with { userId, role }.
   - Returns { user } (passwordHash stripped).
4. login.html reads the response, calls landingFor(user.role):
   - admin/boss/owner/manager/office/pm/estimator → /admin/operations
   - leadingHand/leading_hand/leading-hand/lh → /lh
   - tradie/apprentice/labourer/electrician → /my-day  ⚠️ LEGACY destination
   - client → /client
   - else → /login (no redirect loop)
5. location.href = landingFor(role).
```

Verified at `public/login.html:737-762`.

---

## Redirects (post-login chain)

The post-login chain is multi-step and has been the source of the blank-page regression (`docs/regressions/admin-operations-blank.md`).

For an **admin**:
```
1. /login (POST) → 200, cookie set.
2. login.html JS: location.href = '/admin/operations'.
3. Vercel rewrites /admin/operations → /admin/operations.html.
4. operations.html loads + admin-data.js (mock) preloaded.
5. operations.html splash overlay shown.
6. operations.html boot() calls /api/auth?action=me to verify role.
7. Role gate: ADMIN_ROLES.includes(role) → continue. Otherwise:
   - FIELD_ROLES → location.href = '/phil'
   - LEADING_HAND_ROLES → location.href = '/lh'
   - CLIENT_ROLES → location.href = '/client'
   - unknown → showBootError()
8. Fan-out fetches: /api/jobs, /api/users, /api/time-entries, /api/snags-all, /api/quotes, etc.
9. Splash dismissed in finally{}.
10. Render.
```

For a **tradie**:
```
1. /login (POST) → 200.
2. login.html: location.href = '/my-day'.   ← legacy destination
3. Vercel serves /my-day → /my-day.html.
4. my-day.html boot.
5. (If the user lands at /phil instead, phil.html → /api/auth?action=me → render — but the canonical login path doesn't send them there.)
```

For a **leadingHand**:
```
1. /login → 200.
2. login.html: location.href = '/lh'.
3. Vercel serves /lh → /lh-home.html.
4. lh-home boot.
```

For a **client**:
```
1. /login → 200.
2. login.html: location.href = '/client'.
3. Vercel serves /client → /client.html.
4. Client portal boot.
```

**Risks identified:**
- **Blank-page risk** at step 7 (admin operations role gate) if `me.role` is missing or unknown. The page handles this with `showBootError()` rather than infinite redirect — good. Confirmed in `operations.html:1592-1599`.
- **Splash-stuck risk** at step 9 if any earlier step throws. Outer try/catch + `needSplashDismiss` flag handles this. Confirmed in `operations.html:1574-1581`.
- **Service worker stale-cache risk** at step 4 if `_shell.js` or `_shell.css` was changed without bumping `CACHE_VERSION`. Pre-deploy guard `check-sw-cache-version.js` covers this.
- **PWA install lands wrong** at step 2 for tradies because the manifest's `start_url` is `/my-day` not `/phil`.

---

## Route protection — admin pages

`public/admin/_shell.js` runs an auth gate on every `_shell.js`-driven page:

```js
let me;
try { me = (await api('/api/auth?action=me')).user; }
catch { location.href = '/login'; return; }

if (me.role !== 'admin' && me.role !== 'leadingHand') {
  location.href = me.role === 'tradie' ? '/my-day'
                  : me.role === 'client' ? '/client'
                  : '/login';
  return;
}
```

Verified at `public/admin/_shell.js:259-271`.

Per-page role gates layered on top:

```js
const PAGE_ROLES = {
  today: ['admin'], quotes: ['admin'], crew: ['admin'],
  suppliers: ['admin'], settings: ['admin'], support: ['admin'],
  assets: ['admin'], 'job-builder': ['admin'],
  variations: ['admin'], reports: ['admin'],
};
```

Pages outside `PAGE_ROLES` are visible to both admin and leadingHand. Pages in the map redirect LH to their own home (`/lh`).

The Command Centre SPA at `/admin/operations` has its own role gate using the expanded `ADMIN_ROLES = ['admin', 'boss', 'owner', 'manager', 'office', 'pm', 'estimator']`. This is forward-looking — none of those expanded roles actually exist in `users.json` today.

**Drift:** `_shell.js` checks `role !== 'admin' && role !== 'leadingHand'`. `operations.html` allows 7 admin-capable roles. So a `boss` or `manager` who somehow exists in `users.json` would be admitted to `/admin/operations` but bounced from `/admin/jobs`. Inconsistency.

---

## Server-side permission helpers (api/_lib/auth.js)

```ts
canWrite(user, jobId)      // admin OR (tradie|leadingHand WITH jobId in assignedJobIds)
canManageJob(user, jobId)  // admin OR (leadingHand WITH jobId in assignedJobIds)
```

Two-tier model:
- **canWrite** — write field data (tasks, snags, hours, photos).
- **canManageJob** — write job config (areas, checklists, crew, client).

Clients are read-only by both checks. Tradies have `canWrite` only on assigned jobs. Leading hands have both on assigned jobs. Admins have both on every job.

**Strengths:**
- Server-side, can't be bypassed by client tampering.
- Used consistently across endpoints (every mutation calls one of these).

**Concerns:**
- Hard-coded role names. Adding a new role (e.g. `estimator` with read-only quote access) requires touching every endpoint.
- No org-level permissions (single-tenant assumption).
- No field-level permissions (e.g. can read hours but not rates).
- No audit log of permission failures.

---

## Session persistence

- Cookie maxAge = 30 days. Rolls indefinitely; no explicit refresh.
- `getCurrentUser()` re-reads `users.json` on every request — if the user is archived or has their role changed, the next request reflects that immediately.
- No serverside session table, so revoking a session = changing their bcrypt hash (forced relogin).

**Risk:** there is no way to revoke a specific session without invalidating the bcrypt hash. For a tradie phone that's stolen, the admin's only recourse is to reset the worker's PIN.

---

## Logout

POST `/api/auth?action=logout` → `clearSessionCookie(res)` — sets the cookie to empty with maxAge=0. Browser drops it.

Phil's logout posts to `?action=signout` which doesn't exist; the call 404s silently and Phil redirects to `/phil.html` anyway. Cookie persists. **Phil's logout doesn't actually log the user out.** Critical bug.

---

## Blank-page-after-login risk inventory

| Failure mode                                                                | Mitigation today                                                                                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `SHELL.boot()` missing from a page                                          | `scripts/check-admin-shell.js` (pre-deploy static check)                                          |
| `_shell.js` cached against new shell API                                    | `scripts/check-sw-cache-version.js` (predeploy) — bumps required                                  |
| `boot()` throws after splash up                                             | Outer try/catch + `dismissSplash()` in `finally{}` (operations.html:1574-1581)                    |
| Role gate unknown role                                                      | `showBootError()` shows visible error panel + Sign out button (operations.html:1592-1599)         |
| `/api/auth?action=me` returns 401                                           | Redirect to `/login` (operations.html:1586-1591; _shell.js:264-265)                               |
| Page render throws                                                          | Per-page render try/catch (operations.html:1331+; _shell.js:333-339)                              |
| Page never mounts `#app`                                                    | 5-second blank-shell detector in `_shell.js` adds a visible recovery panel                        |
| Wrong build on production                                                   | `check-prod-branch.js` (HEAD = origin/main) + `check-production-shell.js` (no Birdwood fingerprint) — **but `GUARD_OVERRIDE=YES-I-KNOW` bypass exists and was used** |
| Phil signin endpoint mismatch                                               | **NONE**. Phil signin silently fails.                                                              |
| Tradie logged in but landed on legacy `/my-day` thinking they're using Phil | **NONE**. Manifest + login redirect both point at `/my-day`.                                       |
| Cookie set but role missing                                                 | `showBootError('No session', 'Your sign-in is missing a role assignment...')` — handled.          |
| Two browser tabs in different roles                                         | Not handled; cookie is global. Acceptable for current scale.                                      |
| Local-dev login without SESSION_SECRET set                                  | `secret()` throws on every request — visible error.                                               |

---

## Target permission model for the rebuild

Per the prompt:
- boss / admin
- office user
- project manager
- estimator
- worker
- apprentice
- role-based admin access
- Phil worker access
- BuhlOS Admin access

Translated to a target Role / Permission model:

```ts
type Role =
  | 'boss'           // owner — sees and can do everything
  | 'admin'          // office admin — operations, no boss-only things
  | 'office'         // office user — admin minus money
  | 'project_manager' // job owner — full control of their jobs
  | 'estimator'      // quoting + reports
  | 'leading_hand'   // crew lead — Phil + small admin slice
  | 'tradie'         // qualified worker — Phil
  | 'apprentice'     // unqualified worker — Phil with limited write
  | 'client';        // external client — read-only client portal

type SurfaceAccess =
  | 'buhlos_admin'   // boss, admin, office, project_manager, estimator
  | 'lh_home'        // leading_hand
  | 'phil'           // tradie, apprentice, leading_hand (also has /phil for site visibility)
  | 'client_portal'; // client

// Permissions are tags that a Role grants. Encoded in a table, not hardcoded.
type Permission =
  | 'jobs.read' | 'jobs.create' | 'jobs.edit' | 'jobs.archive'
  | 'hours.submit' | 'hours.read.own' | 'hours.read.all' | 'hours.approve'
  | 'gear.read' | 'gear.assign' | 'gear.scan'
  | 'evidence.capture' | 'evidence.review'
  | 'itp.complete' | 'itp.review' | 'itp.sign_off'
  | 'plans.upload' | 'plans.acknowledge'
  | 'rfi.raise' | 'rfi.triage' | 'rfi.resolve'
  | 'defect.raise' | 'defect.resolve' | 'defect.bulk_close'
  | 'materials.request' | 'materials.order' | 'materials.receive'
  | 'variations.create' | 'variations.invoice'
  | 'users.read' | 'users.create' | 'users.edit' | 'users.archive'
  | 'reports.read'
  | 'cash.read' | 'cash.edit'
  | 'integration.manage';

// Surface gates are based on a one-of-many SurfaceAccess.
// Capabilities are based on the union of permissions a Role grants.
```

A `Role → Permission[]` table replaces the hardcoded `canWrite` / `canManageJob`. Storage initially in code (`src/lib/permissions/role-permissions.ts`), later in DB if/when needed.

---

## Recommended rebuild approach

1. **Keep the cookie + HMAC + bcrypt flow** unchanged. Existing users continue to work without password reset.
2. **One login surface** (`/login` route in Next.js). Phil's in-file login form is deleted.
3. **One logout endpoint** (`/api/auth?action=logout`). Phil's `signout` call is replaced.
4. **Add `/api/auth?action=signin` and `/api/auth?action=signout` as aliases** to handle the existing Phil call paths during transition — or, simpler, fix Phil's calls in the rebuild day-one.
5. **Server-side route protection** in Next.js middleware that:
   - Reads the session cookie.
   - Calls `getCurrentUser` (or its rebuilt equivalent).
   - Maps `Role → SurfaceAccess`.
   - Redirects mismatches (e.g. tradie hits `/admin` → `/phil`).
6. **Client-side guard** for permission-sensitive UI bits. Server is still authoritative; client is for hiding controls the user can't use.
7. **One `landingFor()` function** lives in `src/lib/auth/landing.ts`. Login + middleware both use it.
8. **Permission audit log** — every mutation that fails a permission check writes to `AuditLog` so suspicious patterns surface.

---

## What exists vs what needs rebuild

| Need                                                            | Current state            | Rebuild action                                                  |
| --------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------- |
| HMAC session cookie                                              | ✅ in `_lib/auth.js`     | **Keep.** Wrap in typed Next.js helpers.                         |
| Login form                                                       | ✅ `login.html` works    | **Rebuild** as `src/app/login/page.tsx`. Same endpoint.          |
| `landingFor()` mapping                                           | ✅ in `login.html` inline | **Extract** into `src/lib/auth/landing.ts` (shared).             |
| Per-page admin auth gate                                         | ✅ in `_shell.js`         | **Rebuild** as Next.js middleware.                               |
| Per-page admin role gate (PAGE_ROLES)                            | ✅ in `_shell.js`         | **Rebuild** as middleware + per-route metadata.                  |
| Operations SPA role gate (ADMIN_ROLES expansion)                  | ✅ in `operations.html`   | **Rebuild** — single source of truth in `src/lib/auth/roles.ts`. |
| `canWrite` / `canManageJob`                                      | ✅ in `_lib/auth.js`     | **Replace** with Role → Permission[] table.                      |
| CSRF protection                                                  | ❌ none                   | **Add** explicit CSRF tokens.                                    |
| Phil login                                                       | ❌ broken (`signin` 404)  | **Replace** with the one shared login.                           |
| Phil logout                                                      | ❌ broken (`signout` 404) | **Replace** with the one shared logout.                          |
| Session revocation                                               | ❌ only via password reset | **Add** explicit `/api/auth?action=revoke` (optional).         |
| Blank-page guards                                                | ✅ multi-layer            | **Carry forward** as Next.js error boundaries + middleware redirects. |
| Audit log on permission deny                                     | ❌ not logged             | **Add** — denies write to `AuditLog`.                            |
