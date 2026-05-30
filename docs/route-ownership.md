# BuhlOS + Phil Route Ownership Contract

> Status: **living contract** · Owner: platform · Last reconciled against code: PR 1
> (route-ownership-shell-stabilisation). Guarded by `scripts/check-route-ownership.js`.

## 1. Purpose

This repo is mid-migration: a **legacy** static surface (`public/*.html` + Vercel
serverless `api/*.js`) and a **new** Next.js App Router surface (`src/app/**`)
co-exist. They are wired together by `vercel.json` rewrites (which run *before*
Next.js) and `src/middleware.ts` (which gates only the new surfaces).

When multiple shells co-exist, the recurring failure mode is **the wrong UI
appearing where the user expected a different one** — an old pill-tab admin
layout where the BuhlOS left-nav should be, a placeholder where the worker's
"Today" should be, a blank page from a route that nothing owns, or a stale
cached shell after a deploy. Those failures have shipped to production before
(see [`docs/regressions/admin-operations-blank.md`](regressions/admin-operations-blank.md)).

This document exists so that:

- every important route has an **owner** (BuhlOS / Phil / shared / legacy) and a
  **status** (canonical / transitional / legacy / deprecated);
- every route either **renders intentionally** or **redirects intentionally**;
- modern navigation only links to **approved** modern routes;
- legacy production routes are **preserved** (not deleted, not accidentally
  re-linked from modern surfaces);
- `/v2/*`'s live-but-transitional status is unambiguous;
- future agents can extend the product without resurrecting old layouts.

This is the *reconciled* picture across both surfaces. The legacy-only,
production-URL inventory lives in
[`docs/rebuild-audit/01-current-route-map.md`](rebuild-audit/01-current-route-map.md)
and is not duplicated here.

## 2. Product surface definitions

| Surface | What it is | Shell | Audience |
| --- | --- | --- | --- |
| **BuhlOS Admin** | Desktop control plane — review, approve, manage. | `AdminShell` (`src/components/admin/`): left sidebar + topbar. | boss, admin, PM, estimator, office |
| **Phil** | Mobile-first field app — capture-first, "what's next". | `PhilShell` (`src/components/phil/`): header + bottom tab bar. | tradie, apprentice, labourer, electrician, leading hand |
| **Legacy static shell** | The current production surface: `public/*.html` booted by `public/admin/_shell.js` (admin) or self-contained SPA (`operations.html`, `phil.html`). | legacy JS shells | everyone, today |
| **`/v2/*`** | New-surface routes parked on URLs `vercel.json` does **not** rewrite, so they can ship without a routing cutover. **Live, not abandoned.** | `AdminShell` (`/v2/jobs`) or `PhilShell` (`/v2/phil`) | per route |
| **API** | `api/*.js` Vercel serverless. `buhl_session` cookie gate. Untouched by this PR. | n/a | n/a |

Naming is fixed by [`docs/architecture/00-rebuild-non-negotiables.md`](architecture/00-rebuild-non-negotiables.md):
the surfaces are **BuhlOS** and **Phil**. "Switchboard" / "Site Office" are
deprecated product names and must not appear in new code or UI.

## 3. The two routing layers (read this before changing a route)

1. **`vercel.json` rewrites run first**, in production, and own every legacy URL
   (`/`, `/login`, `/admin/*`, `/buhlos/*`, `/phil`, `/my-day`, `/my-gear`,
   `/lh`, `/client`, `/jobs`, `/overview`, `/approvals`, `/install`, `/dev/*`).
   A rewrite source that *exactly* matches a path wins; it does **not** capture
   deeper paths. `{ "source": "/phil" }` rewrites only `/phil`, **not**
   `/phil/my-day`.
2. **Next.js owns everything `vercel.json` does not rewrite** — `/command-centre`,
   `/hours/*`, `/gear`, `/employees/*`, `/v2/*`, `/phil/my-day`, `/phil/jobs/*`,
   `/phil/hours`, `/phil/gear`, `/phil/onboarding`, `/phil/invite/*`.
3. **`src/middleware.ts` gates only the new surfaces.** Unauthenticated access to
   a gated route → `307` redirect to `/v2/login?next=<path>`. Wrong-surface
   access (e.g. a tradie on `/command-centre`) → `307` to `landingFor(role)`.
   Legacy URLs never reach the middleware.

**Consequence:** a bare `/phil` in production serves **legacy** `phil.html`; the
modern Phil home is `/phil/my-day`. Do not link bare `/phil` from a modern Phil
surface unless you intend to send the user to legacy.

## 4. Canonical routes (today)

Confirmed in code. These are the intended destinations for new navigation.

**Public / entry**

| Route | Source | Notes |
| --- | --- | --- |
| `/` | prod: `public/login.html` (vercel) · dev: `src/app/page.tsx` | Prod root is the legacy sign-in. The Next `page.tsx` redirects per role and is only hit in dev / once `/` is un-rewritten. |
| `/v2/login` | `src/app/v2/login/page.tsx` | New canonical sign-in. Always public. POSTs to legacy `/api/auth?action=login`. Honours a safe `?next=`. |
| `/login` | `public/login.html` (vercel) | Legacy sign-in — still the production default; kept working. |

**BuhlOS Admin** — `AdminShell`, admin roles only (gated)

| Route | Source | Notes |
| --- | --- | --- |
| `/command-centre` | `src/app/(admin)/command-centre/page.tsx` | BuhlOS admin **home**. Queue-shaped attention view + live-surface strip. |
| `/hours` | `src/app/(admin)/hours/page.tsx` | Hours view. |
| `/hours/approvals` | `src/app/(admin)/hours/approvals/page.tsx` | Approvals queue. |
| `/gear` | `src/app/(admin)/gear/page.tsx` | Gear register. |
| `/employees` | `src/app/(admin)/employees/page.tsx` | People / onboarding (O1+). |
| `/employees/[id]` | `src/app/(admin)/employees/[id]/page.tsx` | Employee detail. |
| `/observations` | `src/app/(admin)/observations/page.tsx` | **Observations Inbox** (PR 3). Cross-job field-to-office triage: blockers, plan mismatches, material needs, RFIs, variations, defects, site instructions. Admin-tier gated (matches the `/api/observations` cross-job gate). |
| `/material-requests` | `src/app/(admin)/material-requests/page.tsx` | **Material Requests Inbox** (PR 11). Cross-job procurement queue: requested → approved → ordered → delivered (+ cancel). Admin-tier gated (matches the `/api/material-requests` cross-job gate). Distinct from the legacy `/admin/materials` takeoff/PO/invoice module — this is the field-to-office request loop. |

**Phil** — `PhilShell`, field roles or leading hand (gated)

| Route | Source | Notes |
| --- | --- | --- |
| `/phil/my-day` | `src/app/phil/my-day/page.tsx` | Phil **home** ("Today" tab + the hours loop). Replaces the placeholder `/v2/phil`. |
| `/phil/jobs` | `src/app/phil/jobs/page.tsx` | Assigned jobs list. |
| `/phil/jobs/[jobId]` | `src/app/phil/jobs/[jobId]/page.tsx` | Job detail (capture, snags, ITP, docs). |
| `/phil/jobs/[jobId]/itps/[instanceId]` | `.../itps/[instanceId]/page.tsx` | ITP recording. |
| `/phil/hours` | `src/app/phil/hours/page.tsx` | Hours history / fix-and-resubmit. |
| `/phil/gear` | `src/app/phil/gear/page.tsx` | My gear (return / report damaged / missing). |
| `/phil/onboarding` | `src/app/phil/onboarding/page.tsx` | First-run tour (gated phil). |

## 5. Transitional routes (live, but the URL/shape will change)

These work today and are intentionally linked, but carry a known future move.
**Do not delete them and do not "clean them up."**

| Route | Source | Why transitional |
| --- | --- | --- |
| `/v2/jobs` | `src/app/v2/jobs/page.tsx` | **The live admin Jobs index.** Uses `AdminShell`, gated `admin`/LH. Parked on `/v2/jobs` so it shipped without a `vercel.json` change. Canonical URL becomes `/admin/jobs` in a later admin-shell rebuild slice; legacy `/admin/jobs.html` keeps serving via rewrite until then. The admin sidebar "Jobs" item links here on purpose. |
| `/v2/jobs/[jobId]` (+ `/evidence`, `/snags`, `/itps`, `/documents`, `/observations`, `/material-requests`, `/history`) | `src/app/v2/jobs/[jobId]/**` | Live admin job hub + review sections. PR 8 added `/observations` (per-job slice of the cross-job inbox; LH read-only, admin-tier can triage); PR 9 added `/history` (per-job activity feed reading the audit-log via `scope=job`; admin/LH only); PR 11 added `/material-requests` (per-job slice of the procurement inbox; LH read-only, admin-tier can act). Same future move as `/v2/jobs`. |
| `/v2/phil` | `src/app/v2/phil/page.tsx` | The Phil **"More" / profile placeholder** (orientation line + onboarding replay + a profile/settings UC panel). It is the destination of the Phil tab bar "More" and "Snag" (UC) tabs. The functional Phil home moved to `/phil/my-day`; `/v2/phil` is no longer a landing target (see §10). |
| `/phil/invite/[token]` | `src/app/phil/invite/[token]/page.tsx` | Worker onboarding invite (O3). **Intentionally NOT gated** — a new worker has no session when they open their invite link. Public by design. |

## 6. Legacy routes (preserved — production depends on them)

Served by `vercel.json` → `public/*.html`. These are the current production
surfaces. They are **kept working**; this PR does not delete or redirect them.
Full per-file detail in
[`01-current-route-map.md`](rebuild-audit/01-current-route-map.md).

| Route(s) | File | Why preserved |
| --- | --- | --- |
| `/` , `/login` , `/phil/login` , `/buhlos` , `/buhlos/login` | `public/login.html` | Production sign-in. Load-bearing — `check-production-shell.js` asserts `/` → `/login.html`. |
| `/admin` , `/admin/` | `public/admin/index.html` | Role-redirect shim → `/admin/operations` / `/lh` / `/my-day` / `/client`. |
| `/admin/operations` , `/overview` | `public/admin/operations.html` | **The current production BuhlOS Command Centre SPA.** Load-bearing — guarded by `check-production-shell.js` + `smoke-admin-routes.js`. |
| `/admin/{approvals,snags,jobs,jobs/:id,job-builder,itp,plans,variations,reports,quotes,quotes/:id,hours,crew,suppliers,temps,settings,support,assets,activity,materials,cash}` | `public/admin/*.html` | Legacy admin modules (`_shell.js`). Still the production admin tools. |
| `/phil` , `/phil/app` | `public/phil.html` | Legacy Phil (mock-data; signin endpoint mismatch documented). Reachable; not the modern Phil. |
| `/my-day` | `public/my-day.html` | **Current production tradie home** (legacy login + manifest `start_url` both point here). |
| `/my-gear` | `public/my-gear.html` | Legacy gear page for tradies. |
| `/lh` , `/lh-home` | `public/lh-home.html` | Leading Hand home. `landingFor(lh)` → `/lh`. |
| `/client` , `/client/jobs/:id` | `public/client.html` | Read-only client portal. `landingFor(client)` → `/client`. |
| `/jobs` , `/jobs/:id` , `/jobs/:id/log-hours` | `public/admin/jobs.html` , `public/project.html` | Legacy jobs / per-job page. |
| `/install` | `public/install.html` | PWA install instructions. |

## 7. Deprecated / not-for-new-links routes

Reachable today, but **must not be newly linked from modern navigation**. Slated
for removal in a later, intentional cleanup PR (not this one).

| Route(s) | Why |
| --- | --- |
| `/buhlos/*` (22 mirrors of `/admin/*`) | Pure duplicates of `/admin/*`. Salvage map says discard. Never add a new `/buhlos/*` rewrite. |
| `/overview` , `/approvals` | Bare aliases of `/admin/operations` / `/admin/approvals`. Use the `/admin/*` form (legacy) or the modern route. |
| `/admin-legacy` , `/admin.html` | The pre-BuhlOS 8,180-line admin. Should be deleted in a future PR. |
| `/dev/site-office` , `/dev/site-office/components` | **Deprecated naming** ("Site Office"). Must be removed; never linked. |

## 8. Route ownership table (modern surfaces)

| Route | Owner | Source | Shell | Status | Auth | Linked from | Expected behaviour |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/` | shared | `page.tsx` / vercel | — | canonical | public | — | prod → legacy login; dev → role landing |
| `/v2/login` | shared | `v2/login/page.tsx` | none | canonical | public | not-found, sign-out, login-form | render login; if session → `landingFor` |
| `/command-centre` | BuhlOS | `(admin)/command-centre` | AdminShell | canonical | admin | sidebar, root landing | admin home; unauth → 307 `/v2/login` |
| `/hours` | BuhlOS | `(admin)/hours` | AdminShell | canonical | admin | sidebar, command-centre | hours view |
| `/hours/approvals` | BuhlOS | `(admin)/hours/approvals` | AdminShell | canonical | admin | sidebar, command-centre | approvals queue |
| `/gear` | BuhlOS | `(admin)/gear` | AdminShell | canonical | admin | sidebar, command-centre | gear register |
| `/employees` | BuhlOS | `(admin)/employees` | AdminShell | canonical | admin | sidebar | people / onboarding |
| `/observations` | BuhlOS | `(admin)/observations` | AdminShell | canonical | admin | sidebar, command-centre | observations inbox; unauth → 307 `/v2/login` |
| `/material-requests` | BuhlOS | `(admin)/material-requests` | AdminShell | canonical | admin | sidebar, command-centre | material requests inbox; unauth → 307 `/v2/login` |
| `/v2/jobs` | BuhlOS | `v2/jobs` | AdminShell | transitional | admin/LH | sidebar "Jobs", command-centre | admin jobs index; → `/admin/jobs` later |
| `/v2/jobs/[jobId]/**` | BuhlOS | `v2/jobs/[jobId]/**` | AdminShell | transitional | admin/LH | jobs list rows, command-centre | job hub + review sections |
| `/phil/my-day` | Phil | `phil/my-day` | PhilShell | canonical | field/LH | tab "Today", `landingFor(field)` | Phil home; unauth → 307 `/v2/login` |
| `/phil/jobs` | Phil | `phil/jobs` | PhilShell | canonical | field/LH | tab "Jobs" | jobs list |
| `/phil/jobs/[jobId]/**` | Phil | `phil/jobs/[jobId]/**` | PhilShell | canonical | field/LH | jobs list rows | job detail / ITP |
| `/phil/hours` | Phil | `phil/hours` | PhilShell | canonical | field/LH | my-day, rejected banner | hours history / fix |
| `/phil/gear` | Phil | `phil/gear` | PhilShell | canonical | field/LH | tab "Gear" | my gear |
| `/phil/onboarding` | Phil | `phil/onboarding` | PhilShell | canonical | field/LH | v2/phil "Start the tour" | first-run tour |
| `/v2/phil` | Phil | `v2/phil` | PhilShell | transitional | field/LH | tab "More" / "Snag" (UC) | profile/More placeholder |
| `/phil/invite/[token]` | Phil | `phil/invite/[token]` | (own) | transitional | **public** | invite email | worker setup, no session yet |

## 9. Navigation contract

- **BuhlOS sidebar** (`src/components/admin/AdminSidebar.tsx`) — `live` items may
  only link to approved admin routes: `/command-centre`, `/hours`,
  `/hours/approvals`, `/gear`, `/employees`, `/observations`,
  `/material-requests`, `/v2/jobs`. Unbuilt
  items (`Snags`, `Support`, `Settings`) are rendered as **non-clickable** `UC`
  spans, never `<Link>`s — per the "every incomplete feature shows UNDER
  CONSTRUCTION" non-negotiable. (`Snags` stays UC: per-job snag triage lives on
  the Jobs surface; the cross-job **Observations** inbox now covers field issues.)
- **Phil bottom tab bar** (`src/components/phil/PhilTabBar.tsx`) — a 4-tab +
  centre Capture FAB layout. The `live` tabs (`LEFT_TABS` Today/Jobs, `RIGHT_TABS`
  Gear/More) may only link to approved Phil routes: `/phil/my-day`, `/phil/jobs`,
  `/phil/gear`, `/v2/phil`. The centre **Capture FAB** replaced the old
  non-working `Snag` tab — it is a `<button>` (opens the capture launcher), not a
  nav `<Link>`, so it carries no route. The guard parses both tab arrays and
  treats every tab as live (the `status` field was dropped with the FAB rework).
- **No modern nav component may link to a legacy `public/*.html` route or a
  legacy `/admin/*` URL.** The single intentional legacy link in the app is the
  clearly-labelled "Open legacy Phil" bail-out on `/v2/phil`; it is a page-level
  link, not navigation chrome, and is exempt.
- `/v2/jobs` is the live Jobs route **for now**. When `/admin/jobs` (modern) is
  built, update the sidebar href, this contract, and the guard together.

`scripts/check-route-ownership.js` enforces the bullets above statically.

## 10. Redirect / landing contract

`landingFor(role)` (`src/lib/auth/landing.ts`) is the **one** canonical
role→landing map for the new surfaces (shared by `middleware.ts`,
`src/app/page.tsx`, and the `/v2/login` form — one source of truth):

| Role class | Landing | Surface |
| --- | --- | --- |
| admin (admin/boss/owner/manager/office/pm/estimator) | `/command-centre` | new BuhlOS |
| field (tradie/apprentice/labourer/electrician) | `/phil/my-day` | new Phil |
| leading hand | `/lh` | legacy (LH home not yet rebuilt) |
| client | `/client` | legacy client portal |
| unknown / signed-out | `/v2/login` | — |

> **PR 1 change:** field workers previously landed on `/v2/phil` (the *placeholder*).
> They now land on `/phil/my-day` (the functional "Today" home) — the page that
> page's own docstring says "replaces the placeholder `/v2/phil`". This only
> affects the **new** login/middleware flow; the legacy `login.html` keeps its own
> redirect to `/my-day` and is unchanged.

Other intentional redirects:

- Unauthenticated → gated route ⇒ `307` to `/v2/login?next=<path>`; the login
  form returns the user to a **safe** (`startsWith("/")`) `next`, else `landingFor`.
- Wrong-surface ⇒ `307` to `landingFor(role)` (never a loop: each role's landing
  is on a surface that role can access; LH/client land on legacy, which the
  middleware does not gate).
- Sign-out (`SignOutButton`) ⇒ `/v2/login`.

`landingFor` returning `/lh` / `/client` (legacy URLs unknown to Next's
`typedRoutes`) is why call sites cast `as Route`. That cast is expected until LH
and client surfaces are rebuilt.

## 11. Service worker / cache assessment

`public/sw.js` (`CACHE_VERSION = 'buhl-shell-v7'`) caches **only** the legacy
static-shell asset list: `/admin/_shell.css`, `/admin/_shell.js`, `/theme.css`,
`/manifest.json`, `/BUHL_LOGO.png`, `/icon-192.png`. Its `fetch` handler
intercepts a request **only if** the pathname is in that list. HTML and API
responses are deliberately never cached.

**The service worker never intercepts the Next.js surfaces** (`/command-centre`,
`/v2/*`, `/phil/*`, …). Old modern UI cannot be resurrected by the SW — the
stale-shell risk is confined to the legacy `/admin/*` shell assets, and is
governed by `CACHE_VERSION` + `scripts/check-sw-cache-version.js` (which fails a
deploy if `public/admin/_shell.{js,css}`, `public/theme.css`,
`public/admin/*.html`, or `public/components/*.js` change without a version bump).

**A CACHE_VERSION bump is required only when one of those legacy shell files
changes.** Route/shell changes confined to `src/**`, `docs/**`, `scripts/**`, or
`package.json` (as in this PR) do **not** require a bump, and
`check-sw-cache-version` passes unchanged.

## 12. Future migration plan (safe order)

1. **Normalise auth/API role gates** (PR 2) — align the new `roles.ts` /
   `permissions.ts` taxonomy with the legacy `api/*.js` gates so the same user
   has the same powers on both surfaces.
2. **Rebuild LH + client on the new surfaces** so `landingFor` no longer needs
   the `as Route` legacy casts.
3. **`/admin/jobs` cutover** — build the modern Jobs index at `/admin/jobs`
   (route currently legacy via vercel rewrite), flip the sidebar href and this
   contract together, keep `/v2/jobs` as a redirect for one release.
4. **Phil `/phil` cutover** — once the modern Phil is field-stable, decide whether
   bare `/phil` redirects to `/phil/my-day` (requires removing the
   `/phil` → `phil.html` rewrite) and update the manifest `start_url` from
   `/my-day` to `/phil/my-day`.
5. **Retire legacy** — only after each route has a render smoke test, move
   `public/*.html` behind `/legacy/*` (per non-negotiables) and add compatibility
   redirects; delete `/buhlos/*`, `/dev/site-office/*`, `/admin-legacy` last.

Every step above changes the contract; update §4–§10 **and**
`scripts/check-route-ownership.js` in the same PR that makes the move.

## 13. PR checklist (every route/shell PR runs these)

```bash
npm run typecheck            # tsc --noEmit (typedRoutes validates Link/redirect paths)
npm run lint                 # next lint (no alert/inline-style/deprecated naming)
npm test                     # vitest unit tests
npm run build                # next build
npm run check:admin-shell    # legacy admin pages call SHELL.boot()
npm run check:production-shell  # prod HTML is the BuhlOS shell; vercel "/" → login.html
npm run check:sw-cache-version  # shell changes paired with CACHE_VERSION bump
npm run check:route-ownership   # nav/landing contract (this document)
npm run smoke:admin-routes      # static legacy /admin/operations route chain
# post-deploy, against the preview/prod URL:
npm run smoke:evidence-routes -- <url>   # live status codes for canonical/legacy/API
```

Production ships from `main` only (Vercel GitHub integration). `vercel deploy --prod`
from a branch is forbidden and blocked by `check-prod-branch.js`; every PR gets a
preview URL and that is where it is verified. Rollback is `vercel promote <prev>`.

## 14. Cross-references

- Legacy production URL inventory: [`rebuild-audit/01-current-route-map.md`](rebuild-audit/01-current-route-map.md)
- Non-negotiables (naming, surfaces, deploy): [`architecture/00-rebuild-non-negotiables.md`](architecture/00-rebuild-non-negotiables.md)
- Migration strategy: [`rebuild-audit/16-migration-strategy.md`](rebuild-audit/16-migration-strategy.md)
- Deploy process + critical routes: [`deploy-checklist.md`](deploy-checklist.md)
- Blank-page regression history: [`regressions/admin-operations-blank.md`](regressions/admin-operations-blank.md)
- Route gating: `src/middleware.ts` · Landing map: `src/lib/auth/landing.ts`
- Admin nav: `src/components/admin/AdminSidebar.tsx` · Phil nav: `src/components/phil/PhilTabBar.tsx`
