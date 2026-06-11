# BuhlOS + Phil Route Ownership Contract

> Status: **living contract** · Owner: platform · Last reconciled against code:
> `foundation/route-ownership-shell-contract` (per-page shell enforcement).
> Guarded by `scripts/check-route-ownership.js` + `scripts/check-shell-contract.js`,
> with the redirect/landing contract unit-tested in `src/middleware.test.ts`.

## 1. Purpose

**The legacy interface is gone.** The 2026-06 legacy-interface cutover
(`docs/legacy-cutover.md`) deleted the legacy static surface (`public/*.html`
shells) and replaced every old URL with a `307` redirect to its canonical
modern route. The product now has exactly two interfaces — **BuhlOS**
(`src/app` admin routes, desktop/office) and **Phil** (`src/app/phil/*`,
mobile/field) — plus the serverless `api/*.js` data layer and ONE kept static
page (`/client`, the read-only client portal, replacement tracked as
[#271](https://github.com/oskar-ott/BuhlOS/issues/271)).

The recurring historical failure mode was **old UI resurfacing where modern UI
should be** — stale static HTML, rewrites serving deleted shells, a service
worker replaying cached layouts, "open the old page" links in modern chrome
(see [`docs/regressions/admin-operations-blank.md`](regressions/admin-operations-blank.md)).
Those failure paths are now structurally closed and guarded
(`scripts/check-legacy-quarantine.js`).

This document exists so that:

- every important route has an **owner** (BuhlOS / Phil / shared) and a
  **status** (canonical / transitional / redirected / removed);
- every route either **renders intentionally**, **redirects intentionally**,
  or **404s intentionally**;
- modern navigation only links to **approved** modern routes;
- the legacy estate **stays deleted** — nothing may serve, link, cache,
  rewrite to, or fall back to it;
- `/v2/*`'s live-but-transitional status is unambiguous;
- future agents can extend the product without resurrecting old layouts.

The pre-cutover, legacy-URL inventory survives as history in
[`docs/rebuild-audit/01-current-route-map.md`](rebuild-audit/01-current-route-map.md)
(deprecated historical reference only — those files no longer exist).

## 2. Product surface definitions

| Surface | What it is | Shell | Audience |
| --- | --- | --- | --- |
| **BuhlOS Admin** | Desktop control plane — review, approve, manage. | `AdminShell` (`src/components/admin/`): left sidebar + topbar. | boss, admin, PM, estimator, office |
| **Phil** | Mobile-first field app — capture-first, "what's next". | `PhilShell` (`src/components/phil/`): header + bottom tab bar. | tradie, apprentice, labourer, electrician, leading hand |
| **Client portal** | `public/client.html` — the ONE static page kept from the legacy estate (read-only, external-customer-facing). Self-contained (`theme.css` + `css/buhlos.css`); replacement tracked as #271. | static page | clients |
| **`/v2/*`** | Modern routes parked on `/v2` URLs from the parallel-running era. **Live, not abandoned** — renamed to canonical URLs in their own future cutovers. | `AdminShell` (`/v2/jobs`) or `PhilShell` (`/v2/phil`) | per route |
| **API** | `api/*.js` Vercel serverless. `buhl_session` cookie gate. | n/a | n/a |

The **legacy static shell** (`public/*.html` + `public/admin/_shell.js`) was
**removed** in the legacy-interface cutover. It must not come back; see §6.

Naming is fixed by [`docs/architecture/00-rebuild-non-negotiables.md`](architecture/00-rebuild-non-negotiables.md):
the surfaces are **BuhlOS** and **Phil**. "Switchboard" / "Site Office" are
deprecated product names and must not appear in new code or UI.

## 3. The routing layers (read this before changing a route)

1. **`vercel.json` redirects run first**, at the platform edge. Every old
   legacy URL (`/login`, `/admin/*`, `/buhlos/*`, `/phil`, `/my-day`,
   `/my-gear`, `/lh`, `/jobs`, `/overview`, `/approvals`, `/install`, plus the
   old `*.html` paths) `307`-redirects to its canonical modern route — the full
   matrix is in §6 and is guard-enforced. The ONLY rewrites left are
   `/client` + `/client/jobs/:jobId` → `/client.html` (the kept client portal).
2. **Next.js owns everything else** — `/` (session-aware landing in
   `src/app/page.tsx`), `/command-centre`, `/hours/*`, `/gear`, `/employees/*`,
   `/v2/*`, `/phil/my-day`, `/phil/jobs/*`, `/phil/hours`, `/phil/gear`,
   `/phil/onboarding`, `/phil/invite/*`. Anything Next doesn't define is a 404
   (e.g. `/admin-legacy`, `/dev/*` — intentionally dead).
3. **`src/middleware.ts` gates the modern surfaces.** Unauthenticated access to
   a gated route → `307` redirect to `/v2/login?next=<path>`. Wrong-surface
   access (e.g. a tradie on `/command-centre`) → `307` to `landingFor(role)`.
   Redirected legacy URLs never reach the middleware.

**Consequence:** there is no URL anywhere that renders legacy UI. A bare
`/phil` redirects to `/phil/my-day`; `/` lands by session.

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
| `/hours/weekly` | `src/app/(admin)/hours/weekly/page.tsx` | Weekly closeout / payroll readiness (PR #113). |
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
| `/phil/jobs/[jobId]/plans` | `.../plans/page.tsx` | Read-only Plan Viewer (Phase 1). Field sees **current revisions only** — superseded/archived never reach the field. Gated on the job's `plans` module flag. |
| `/phil/hours` | `src/app/phil/hours/page.tsx` | Hours history / fix-and-resubmit. |
| `/phil/gear` | `src/app/phil/gear/page.tsx` | My gear (return / report damaged / missing). |
| `/phil/onboarding` | `src/app/phil/onboarding/page.tsx` | First-run tour (gated phil). |

## 5. Transitional routes (live, but the URL/shape will change)

These work today and are intentionally linked, but carry a known future move.
**Do not delete them and do not "clean them up."**

| Route | Source | Why transitional |
| --- | --- | --- |
| `/v2/jobs` | `src/app/v2/jobs/page.tsx` | **The live admin Jobs index.** Uses `AdminShell`, gated `admin`/LH. Parked on `/v2/jobs` so it shipped without a `vercel.json` change. Canonical URL becomes `/admin/jobs` in a later admin-shell rebuild slice; legacy `/admin/jobs.html` keeps serving via rewrite until then. The admin sidebar "Jobs" item links here on purpose. Admins also get an in-page "New job" button (→ `/v2/jobs/new`) and a per-row "Build" chip (→ `/v2/jobs/[jobId]/builder`). |
| `/v2/jobs/new` | `src/app/v2/jobs/new/page.tsx` | **Create-a-draft form (admin only).** Creates a `draft` job (office-only) with just a name (+ optional ref/address), then routes into the builder. Admin-gated server-side (POST `/api/jobs`) and in the page; a non-admin is redirected to `/v2/jobs`. Same future move as `/v2/jobs`. |
| `/v2/jobs/[jobId]` (+ `/evidence`, `/snags`, `/itps`, `/documents`, `/builder`, `/observations`, `/material-requests`, `/history`, `/plans`) | `src/app/v2/jobs/[jobId]/**` | Live admin job hub + review sections. `/builder` is the **Job Builder / Editor** (admin only — basics/structure/field-modules/Phil-preview/publish). PR 8 added `/observations` (per-job slice of the cross-job inbox; LH read-only, admin-tier can triage); PR 9 added `/history` (per-job activity feed reading the audit-log via `scope=job`; admin/LH only); PR 11 added `/material-requests` (per-job slice of the procurement inbox; LH read-only, admin-tier can act). The Plans-Phase-1 PR added `/plans` (read-only raster Plan Viewer; admin/LH see **current + superseded**, never archived; gated on the job's `plans` module flag). Other sections are admin/LH. Same future move as `/v2/jobs`. |
| `/v2/phil` | `src/app/v2/phil/page.tsx` | The Phil **"More" / profile placeholder** (orientation line + onboarding replay + a profile/settings UC panel). It is the destination of the Phil tab bar "More" and "Snag" (UC) tabs. The functional Phil home moved to `/phil/my-day`; `/v2/phil` is no longer a landing target (see §10). |
| `/phil/invite/[token]` | `src/app/phil/invite/[token]/page.tsx` | Worker onboarding invite (O3). **Intentionally NOT gated** — a new worker has no session when they open their invite link. Public by design. |

## 6. Old legacy URLs (redirected — the files are deleted)

The legacy-interface cutover deleted every legacy page and turned the URLs
into `307` redirects (`vercel.json` `redirects`; matrix guard-enforced by
`scripts/check-legacy-quarantine.js` + `src/routing/legacy-redirects.test.ts`,
live-verified by `npm run smoke:legacy-redirects -- <url>`). Installed field
PWAs (old manifest `start_url: /my-day`), crew bookmarks and historical push
deep-links depend on this matrix — **never remove an entry**; re-point it if a
canonical route moves.

| Old URL(s) | Redirects to | Note |
| --- | --- | --- |
| `/login` , `/login.html` , `/buhlos` , `/buhlos/login` , `/phil/login` | `/v2/login` | The only sign-in. |
| `/phil` , `/phil/app` , `/phil.html` , `/my-day` , `/my-day.html` | `/phil/my-day` | The Phil home. |
| `/my-gear` , `/my-gear.html` | `/phil/gear` | |
| `/phil-hours.html` | `/phil/hours` | |
| `/lh` , `/lh-home` , `/lh-home.html` | `/phil/my-day` | LHs are field-tier; the LH home was absorbed into Phil (LH extras ride `/v2/jobs` read access). |
| `/install` , `/install.html` , `/project.html` | `/phil/my-day` | Modern Phil is installable directly (manifest + SW). |
| `/jobs` | `/v2/jobs` | Admin jobs index. |
| `/jobs/:id` , `/jobs/:id/log-hours` | `/phil/jobs/:id` | Field-biased: these URLs circulated via worker push deep-links. |
| `/admin` , `/admin.html` , `/admin/index.html` , `/admin/operations(.html)` , `/overview` , `/buhlos/admin(/operations)` | `/command-centre` | The admin entry. |
| `/admin/approvals` , `/approvals` | `/hours/approvals` | |
| `/admin/hours` | `/hours` | |
| `/admin/crew` | `/employees` | |
| `/admin/jobs` , `/admin/jobs/:id` , `/admin/job-builder` | `/v2/jobs` , `/v2/jobs/:id` , `/v2/jobs` | |
| `/admin/assets` | `/gear` | |
| `/admin/materials` | `/material-requests` | Field-request inbox; legacy takeoff/PO module retired (no modern equivalent yet). |
| `/admin/{snags,itp,plans,variations,reports,quotes,quotes/:id,suppliers,temps,settings,support,activity,cash}` + `/buhlos/admin/*` mirrors | `/command-centre` | No modern equivalent yet — single honest entry; capability gaps tracked in the backlog. |

**Intentionally dead (404, no redirect):** `/admin-legacy`, `/dev/site-office*`,
`/dev/components`, and every deleted static asset (`/admin/_shell.js`,
`/admin/admin-data.js`, `/components/*.js`, `/lib/*.js`, `/install-prompt.js`,
`/log-hours-sheet.js`, `/mobile-nav.js`, `/css/buhlos-admin.css`,
`/BUHL_LOGO.png`, `/logo.png`). These were never user-entered URLs.

**The kept exception:** `/client` + `/client/jobs/:id` still rewrite to
`public/client.html` (read-only client portal — external customers; replacement
tracked as #271 / Epic 16). It is self-contained: `theme.css` +
`css/buhlos.css` exist only for it.

## 7. Resurrection bans

The legacy estate must stay dead. `scripts/check-legacy-quarantine.js`
(predeploy + CI) fails the build if any of these reappear:

- any deleted legacy file/dir (see list in the script);
- any `.html` in `public/` other than `client.html`;
- a `vercel.json` rewrite to anything except `/client.html`, a redirect to any
  `.html`, or a missing/changed legacy redirect;
- a manifest that isn't the Phil manifest (`start_url /phil/my-day`);
- a service worker that precaches/serves assets or deep-links legacy URLs;
- quoted legacy-URL literals (`'/my-day'`, `'/admin/…'`, `'/jobs/…'`, bare
  `'/phil'`, any `'….html'`) or banned phrases ("Site Office", "legacy
  layout", "old admin shell", "legacy fallback", "classic admin", "pills
  layout", "Birdwood IV3232") in live code.

## 8. Route ownership table (modern surfaces)

| Route | Owner | Source | Shell | Status | Auth | Linked from | Expected behaviour |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/` | shared | `page.tsx` / vercel | — | canonical | public | — | prod → legacy login; dev → role landing |
| `/v2/login` | shared | `v2/login/page.tsx` | none | canonical | public | not-found, sign-out, login-form | render login; if session → `landingFor` |
| `/command-centre` | BuhlOS | `(admin)/command-centre` | AdminShell | canonical | admin | sidebar, root landing | admin home; unauth → 307 `/v2/login` |
| `/hours` | BuhlOS | `(admin)/hours` | AdminShell | canonical | admin | sidebar, command-centre | hours view |
| `/hours/approvals` | BuhlOS | `(admin)/hours/approvals` | AdminShell | canonical | admin | sidebar, command-centre | approvals queue |
| `/hours/weekly` | BuhlOS | `(admin)/hours/weekly` | AdminShell | canonical | admin | /hours CTA | weekly closeout / payroll readiness |
| `/gear` | BuhlOS | `(admin)/gear` | AdminShell | canonical | admin | sidebar, command-centre | gear register |
| `/employees` | BuhlOS | `(admin)/employees` | AdminShell | canonical | admin | sidebar | people / onboarding |
| `/observations` | BuhlOS | `(admin)/observations` | AdminShell | canonical | admin | sidebar, command-centre | observations inbox; unauth → 307 `/v2/login` |
| `/material-requests` | BuhlOS | `(admin)/material-requests` | AdminShell | canonical | admin | sidebar, command-centre | material requests inbox; unauth → 307 `/v2/login` |
| `/v2/jobs` | BuhlOS | `v2/jobs` | AdminShell | transitional | admin/LH | sidebar "Jobs", command-centre | admin jobs index; → `/admin/jobs` later |
| `/v2/jobs/new` | BuhlOS | `v2/jobs/new` | AdminShell | transitional | **admin** | jobs index "New job" | create draft → 307 in-page non-admin → `/v2/jobs`; on create → `/v2/jobs/[jobId]/builder` |
| `/v2/jobs/[jobId]` | BuhlOS | `v2/jobs/[jobId]` | AdminShell | transitional | admin/LH | jobs list rows, command-centre | job hub (overview, site, build/publish card, section nav) |
| `/v2/jobs/[jobId]/builder` | BuhlOS | `v2/jobs/[jobId]/builder` | AdminShell | transitional | **admin** | jobs "Build" chip, hub "Open builder", new-job redirect | Job Builder/Editor; non-admin → `/v2/jobs/[jobId]` |
| `/v2/jobs/[jobId]/{evidence,snags,itps,documents}` | BuhlOS | `v2/jobs/[jobId]/**` | AdminShell | transitional | admin/LH | jobs list rows, hub section nav | per-section review surfaces |
| `/v2/jobs/[jobId]/plans` | BuhlOS | `v2/jobs/[jobId]/plans` | AdminShell | transitional | admin/LH | hub section nav (gated on `plans` module) | read-only Plan Viewer; current + superseded; unauth → 307 `/v2/login` |
| `/phil/my-day` | Phil | `phil/my-day` | PhilShell | canonical | field/LH | tab "Today", `landingFor(field)` | Phil home; unauth → 307 `/v2/login` |
| `/phil/jobs` | Phil | `phil/jobs` | PhilShell | canonical | field/LH | tab "Jobs" | jobs list |
| `/phil/jobs/[jobId]/**` | Phil | `phil/jobs/[jobId]/**` | PhilShell | canonical | field/LH | jobs list rows | job detail / ITP |
| `/phil/jobs/[jobId]/plans` | Phil | `phil/jobs/[jobId]/plans` | PhilShell | canonical | field/LH | job detail "Open plan viewer" (gated on `plans` module) | read-only Plan Viewer; **current revisions only**; unauth → 307 `/v2/login` |
| `/phil/hours` | Phil | `phil/hours` | PhilShell | canonical | field/LH | my-day, rejected banner | hours history / fix |
| `/phil/gear` | Phil | `phil/gear` | PhilShell | canonical | field/LH | tab "Gear" | my gear |
| `/phil/onboarding` | Phil | `phil/onboarding` | PhilShell | canonical | field/LH | v2/phil "Start the tour" | first-run tour |
| `/v2/phil` | Phil | `v2/phil` | PhilShell | transitional | field/LH | tab "More" / "Snag" (UC) | profile/More placeholder |
| `/phil/invite/[token]` | Phil | `phil/invite/[token]` | (own) | transitional | **public** | invite email | worker setup, no session yet |

### 8.1 Shell + guard coverage matrix

The same picture as a **safety** view: every route the platform classifies, its
intended shell, and the guard that holds the line. "Risk" is the specific
failure that has happened (or could) if the row is left unguarded.

| Route | Owner | Shell | Source file | Status | Risk | Test/guard |
| --- | --- | --- | --- | --- | --- | --- |
| `/` | shared | none (redirect) | prod `public/login.html` (vercel) · dev `src/app/page.tsx` | canonical | legacy prototype root leaks to prod | `check-production-shell` (`/`→`login.html`), `smoke-admin-routes` |
| `/login` | legacy | legacy login | `public/login.html` (vercel) | legacy | admin→ops redirect breaks | `smoke-admin-routes` (login→`/admin/operations`) |
| `/v2/login` | shared | none (bespoke) | `src/app/v2/login/page.tsx` | canonical | shell creep; gets gated | `check-route-ownership` (required source), `check-shell-contract` (SHELL_EXEMPT), `middleware.test` (always public) |
| `/command-centre` | BuhlOS | AdminShell | `src/app/(admin)/command-centre/page.tsx` | canonical | blank after login / wrong shell | `check-shell-contract`, `middleware.test`, `auth-routing.spec` |
| `/hours` · `/hours/approvals` · `/hours/weekly` · `/gear` · `/employees` · `/employees/[id]` · `/observations` · `/material-requests` | BuhlOS | AdminShell | `src/app/(admin)/**` | canonical | blank / wrong shell | `check-shell-contract`, `middleware.test`, `check-route-ownership` |
| `/admin` · `/admin/` | legacy | legacy shim | `public/admin/index.html` (vercel) | legacy | dead redirect | `smoke-admin-routes` (admin→ops) |
| `/admin/operations` (+ `/overview`) | legacy | legacy BuhlOS SPA | `public/admin/operations.html` (vercel) | legacy (load-bearing) | blank ops / wrong shell / stale SW | `check-production-shell`, `check-admin-shell`, `smoke-admin-routes`, `check-sw-cache-version` |
| `/admin/*` (approvals, jobs, itp, plans, variations, reports, …) | legacy | legacy `_shell.js` | `public/admin/*.html` (vercel) | legacy | blank page (missing boot) / stale SW | `check-admin-shell`, `check-sw-cache-version` |
| `/v2/jobs` | BuhlOS | AdminShell | `src/app/v2/jobs/page.tsx` | transitional | wrong shell / nav drift | `check-shell-contract`, `check-route-ownership` (approved nav), `middleware.test`, `auth-routing.spec` |
| `/v2/jobs/new` · `/v2/jobs/[jobId]` (+ evidence/snags/itps/documents/observations/material-requests/history) | BuhlOS | AdminShell | `src/app/v2/jobs/[jobId]/**` | transitional | wrong shell | `check-shell-contract`, `middleware.test` |
| `/v2/jobs/[jobId]/builder` | BuhlOS | AdminShell | `…/builder/page.tsx` | transitional | wrong shell; admin-only gate | `check-shell-contract`, `check-route-ownership` (required source) |
| `/v2/jobs/[jobId]/plans` | BuhlOS | AdminShell | `…/plans/page.tsx` | transitional | wrong shell | `check-shell-contract`, `check-route-ownership` (required source) |
| `/v2/phil` | Phil | PhilShell | `src/app/v2/phil/page.tsx` | transitional | renders the admin shell | `check-shell-contract` (cross-shell), `middleware.test` |
| `/phil` · `/phil/app` | legacy | legacy `phil.html` | `public/phil.html` (vercel) | legacy | bare `/phil` linked from modern nav | `check-route-ownership` (forbidden `/phil`) |
| `/phil/my-day` · `/phil/hours` · `/phil/gear` · `/phil/jobs` · `/phil/jobs/[jobId]` (+ itps) · `/phil/onboarding` | Phil | PhilShell | `src/app/phil/**` | canonical | renders admin shell / blank | `check-shell-contract`, `middleware.test`, `phil.spec` |
| `/phil/jobs/[jobId]/plans` | Phil | PhilShell | `…/plans/page.tsx` | canonical | wrong shell | `check-shell-contract`, `check-route-ownership` (required source) |
| `/phil/invite/[token]` | Phil | own (public) | `src/app/phil/invite/[token]/page.tsx` | transitional | gets gated / wrong shell | `check-shell-contract` (SHELL_EXEMPT; cross-shell still applies) |
| `/my-day` | legacy | legacy tradie home | `public/my-day.html` (vercel) | legacy | linked from modern nav | `check-route-ownership` (forbidden `/my-day`) |
| `/my-gear` | legacy | legacy gear | `public/my-gear.html` (vercel) | legacy | linked from modern nav | `check-route-ownership` (forbidden `/my-gear`) |
| `/lh` · `/lh-home` · `/client` · `/jobs` · `/install` · `/approvals` | legacy | legacy HTML | `public/*.html` · `public/admin/*.html` (vercel) | legacy | linked from modern nav / dead | `check-route-ownership` (forbidden), `smoke-admin-routes` (overview/approvals) |
| `/buhlos/*` (22 mirrors of `/admin/*`) | legacy | legacy `_shell.js` | `public/admin/*.html` (vercel) | deprecated | re-linked from modern nav | `check-route-ownership` (forbidden `/buhlos/`) |
| `/dev/site-office` · `/dev/site-office/components` | legacy | dev components | `public/dev/site-office/components.html` (vercel) | **deprecated naming** | "Site Office" reappears as current | `check-route-ownership` (forbidden + deprecated-name label), `smoke-admin-routes` (no `data-sec="switchboard"`) |
| `/admin-legacy` · `/admin.html` | legacy | pre-BuhlOS admin | `public/admin.html` (vercel) | deprecated | leaks as current admin | `check-route-ownership` (forbidden), `check-production-shell` (no "Birdwood IV3232") |

### 8.2 Shell rendering contract (per-page) — `scripts/check-shell-contract.js`

The modern surfaces apply their shell chrome **per page**: each `page.tsx` wraps
its body in `<AdminShell>` or `<PhilShell>` (or delegates to a co-located screen
component that does, e.g. `src/app/(admin)/employees/EmployeesScreen.tsx`). The
route-group layouts (`src/app/(admin)/layout.tsx`, `src/app/phil/layout.tsx`,
`src/app/v2/phil/layout.tsx`) are deliberate pass-throughs.

That convention is flexible but was previously unguarded — a new admin page
could forget `<AdminShell>` and render a chromeless blank, or a Phil page could
import the wrong shell and show a tradie the desktop admin sidebar. The shells
carry stable markers (`AdminShell` → `data-testid="buhlos-admin-shell"`,
`PhilShell` → `data-testid="phil-shell"`) that the Playwright smoke also asserts.

`check-shell-contract.js` freezes three rules statically (no build, no network):

- **A — cross-shell prohibition.** No file under an admin route subtree
  (`src/app/(admin)`, `src/app/v2/jobs`) may import `PhilShell`; no file under a
  Phil subtree (`src/app/phil`, `src/app/v2/phil`) may import `AdminShell`. A
  BuhlOS route can never render the Phil shell, and vice versa.
- **B — shell presence (no silent blanks).** Every `page.tsx` under those
  subtrees must reach its own shell, in the page or a co-located component it
  imports. The only exemptions (full-screen / public chrome, no surface shell)
  are an explicit, reasoned allowlist: `/v2/login`, `/phil/invite/[token]`,
  `/phil/onboarding`.
- **C — marker stability.** `AdminShell` / `PhilShell` still exist and still
  carry their `data-testid` + nav chrome, so the runtime smoke can't assert a
  marker that was silently renamed away.

When a route intentionally changes surface, update the `DOMAINS` / `SHELL_EXEMPT`
lists in the guard **and** §8 / §8.1 here in the same PR.

## 9. Navigation contract

- **BuhlOS sidebar** (`src/components/admin/AdminSidebar.tsx`) — `live` items may
  only link to approved admin routes: `/command-centre`, `/hours`,
  `/hours/approvals`, `/hours/weekly`, `/gear`, `/employees`, `/observations`,
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
  legacy/deprecated URL.** The forbidden set is `*.html`, `/admin/*`,
  `/admin-legacy`, `/buhlos/*`, `/dev/site-office*`, `/my-day`, `/my-gear`,
  `/overview`, `/approvals`, and bare `/phil`. The single intentional legacy link
  in the app is the clearly-labelled "Open legacy Phil" bail-out on `/v2/phil`;
  it is a page-level link, not navigation chrome, and is exempt.
- **Deprecated product names must not reappear as current UI.** No modern nav
  label may be "Switchboard" or "Site Office" (the old surface names; the
  surfaces are **BuhlOS** and **Phil**). The guard matches `\bSwitchboard\b`,
  which spares the electrical-register sense "Switchboards" and the ITP scope
  value `switchboard`; the legacy shell's own `data-sec="switchboard"` ban lives
  in `scripts/smoke-admin-routes.js`.
- **Deprecated product names must not survive in the active _legacy_ surfaces
  either.** Beyond nav labels, `check-route-ownership.js` scans the production
  user-facing legacy files — `public/login.html`, `public/phil.html`,
  `public/lh-home.html`, `public/admin/_shell.js` — and fails if the deprecated
  product name **Site Office** appears. Replace office-app references with
  **BuhlOS**. Two senses are spared: the `buhl-site-office-*` localStorage key
  prefix (kept so existing prefs aren't orphaned; the modern app cleans it up in
  `src/app/v2/login/login-form.tsx`) and the electrical sense of _switchboard_
  (never matched by this check). The same invariant is unit-tested in
  `src/naming/deprecated-naming.test.ts`.
- `/v2/jobs` is the live Jobs route **for now**. When `/admin/jobs` (modern) is
  built, update the sidebar href, this contract, and the guard together.

`scripts/check-route-ownership.js` enforces the bullets above statically.

## 10. Redirect / landing contract

`landingFor(role)` (`src/lib/auth/landing.ts`) is the **one** canonical
role→landing map for the new surfaces (shared by `middleware.ts`,
`src/app/page.tsx`, and the `/v2/login` form — one source of truth):

| Role class | Landing | Surface |
| --- | --- | --- |
| admin (admin/boss/owner/manager/office/pm/estimator) | `/command-centre` | BuhlOS |
| field (tradie/apprentice/labourer/electrician) | `/phil/my-day` | Phil |
| leading hand | `/phil/my-day` | Phil (the legacy `/lh` home was removed in the cutover; LHs additionally hold `/v2/jobs` read access via the middleware `lh` surface) |
| client | `/client` | kept client portal (static; #271 replaces it) |
| unknown / signed-out | `/v2/login` | — |

> **Cutover note:** the legacy `login.html` carried its own private
> `landingFor()` (admin → `/admin/operations`, tradie → `/my-day`, …). It was
> deleted with the page — `src/lib/auth/landing.ts` is now the only landing
> logic in the product, used by the login form, `src/app/page.tsx` and the
> middleware alike.

Other intentional redirects:

- Unauthenticated → gated route ⇒ `307` to `/v2/login?next=<path>`; the login
  form returns the user to a **safe** (`startsWith("/")`) `next`, else `landingFor`.
- Wrong-surface ⇒ `307` to `landingFor(role)` (never a loop: each role's landing
  is on a surface that role can access; clients land on the ungated static portal).
- Sign-out (`SignOutButton`) ⇒ `/v2/login`.

`landingFor` returning `/client` (a static page unknown to Next's `typedRoutes`)
is why call sites cast `as Route`. That cast disappears when the modern client
portal lands (#271).

The middleware decisions above are unit-tested in `src/middleware.test.ts`
(runs in `npm run test:unit`, no browser/preview/credentials): `/v2/login`
always passes, unauthenticated gated routes `307` to `/v2/login?next=<path>`,
each role reaches its own surface, and wrong-surface users `307` to
`landingFor(role)`. The Playwright `auth-routing.spec.ts` proves the same
contract end-to-end against a live preview; the unit test catches a regression
before a preview even builds.

## 11. Service worker / cache contract

`public/sw.js` (`SW_VERSION = 'buhl-sw-v9'`) is **push-only**:

- **No caching, no fetch handler.** The pre-cutover worker's
  stale-while-revalidate shell cache is exactly how old layouts resurrected
  after deploys; v9 caches nothing and its `activate` purges **every** cache
  on the origin (devices still carrying `buhl-shell-v1..v8` come clean on
  first contact).
- **Web Push stays.** Hour reminders, office-inbox fan-out, digests and
  overrun alerts deliver through this worker; deep-link defaults are
  `/phil/my-day`. Existing `PushSubscription`s are registered against the
  `/sw.js` URL — **never move or delete the file**; change behaviour and bump
  `SW_VERSION`.
- Registration happens in the modern shells (`PwaRegistrar` mounted by
  `PhilShell` + `AdminShell`); explicit opt-in lives in
  `PushNotificationsCard` (`/v2/phil` + `/command-centre`).
- `scripts/check-sw-cache-version.js` fails a deploy that changes `sw.js`
  without bumping `SW_VERSION`; `scripts/check-legacy-quarantine.js` fails one
  that reintroduces caching or legacy references.

## 12. Future migration plan (safe order)

1. **Rebuild the client portal** (#271 / Epic 16) — then retire
   `public/client.html`, the two `/client` rewrites, `theme.css` +
   `css/buhlos.css`, and the `as Route` cast in landing call sites.
2. **`/admin/jobs` cutover** — build the modern Jobs index at `/admin/jobs`,
   flip the sidebar href, re-point the `/admin/jobs*` (and `/v2/jobs*`)
   redirect entries, and update §6 + the guards together.
3. **Rebuild the retired legacy-only capabilities** where the backlog calls
   for them (plan uploads + revision curation, materials takeoff/PO/invoice,
   asset create/edit, quoting/variations/reports/cash) — each lands as a
   modern surface; `/command-centre` redirect targets in §6 can then be
   re-pointed to the real module.

Every step above changes the contract; update §4–§10 **and**
`scripts/check-route-ownership.js` + `scripts/check-legacy-quarantine.js` +
`src/routing/legacy-redirects.test.ts` in the same PR that makes the move.

## 13. PR checklist (every route/shell PR runs these)

```bash
npm run typecheck            # tsc --noEmit (typedRoutes validates Link/redirect paths)
npm run lint                 # next lint (no alert/inline-style/deprecated naming)
npm run test:unit            # vitest (incl. middleware + legacy-redirects contracts)
npm run build                # next build
npm run check:admin-shell    # legacy admin shell stays deleted
npm run check:production-shell  # root owned by Next; legacy entries redirect; shells intact
npm run check:sw-cache-version  # sw.js changes paired with SW_VERSION bump
npm run check:route-ownership   # nav/landing contract + legacy-estate tripwire
npm run check:shell-contract    # every modern route renders its intended shell (§8.2)
npm run check:legacy-quarantine # the legacy interface stays dead (§7)
npm run smoke:admin-routes      # static admin chain: redirects → /command-centre
# post-deploy, against the preview/prod URL:
npm run smoke:evidence-routes -- <url>     # live status codes for canonical/API routes
npm run smoke:legacy-redirects -- <url>    # live legacy-URL redirect/404 matrix
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
- Route gating: `src/middleware.ts` (tested: `src/middleware.test.ts`) · Landing map: `src/lib/auth/landing.ts`
- Admin nav: `src/components/admin/AdminSidebar.tsx` · Phil nav: `src/components/phil/PhilTabBar.tsx`
- Shells: `src/components/admin/AdminShell.tsx` · `src/components/phil/PhilShell.tsx`
- Route/shell guards: `scripts/check-route-ownership.js` · `scripts/check-shell-contract.js` (§8.2)
