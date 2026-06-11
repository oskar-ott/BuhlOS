# BuhlOS + Phil Route Ownership Contract

> Status: **living contract** · Owner: platform · Last reconciled against code:
> `foundation/route-ownership-shell-contract` (per-page shell enforcement).
> Guarded by `scripts/check-route-ownership.js` + `scripts/check-shell-contract.js`,
> with the redirect/landing contract unit-tested in `src/middleware.test.ts`.

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

The middleware decisions above are unit-tested in `src/middleware.test.ts`
(runs in `npm run test:unit`, no browser/preview/credentials): `/v2/login`
always passes, unauthenticated gated routes `307` to `/v2/login?next=<path>`,
each role reaches its own surface, and wrong-surface users `307` to
`landingFor(role)`. The Playwright `auth-routing.spec.ts` proves the same
contract end-to-end against a live preview; the unit test catches a regression
before a preview even builds.

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
npm run test:unit            # vitest (incl. src/middleware.test.ts redirect contract)
npm run build                # next build
npm run check:admin-shell    # legacy admin pages call SHELL.boot()
npm run check:production-shell  # prod HTML is the BuhlOS shell; vercel "/" → login.html
npm run check:sw-cache-version  # shell changes paired with CACHE_VERSION bump
npm run check:route-ownership   # nav/landing contract + deprecated-name nav (this document)
npm run check:shell-contract    # every modern route renders its intended shell (§8.2)
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
- Route gating: `src/middleware.ts` (tested: `src/middleware.test.ts`) · Landing map: `src/lib/auth/landing.ts`
- Admin nav: `src/components/admin/AdminSidebar.tsx` · Phil nav: `src/components/phil/PhilTabBar.tsx`
- Shells: `src/components/admin/AdminShell.tsx` · `src/components/phil/PhilShell.tsx`
- Route/shell guards: `scripts/check-route-ownership.js` · `scripts/check-shell-contract.js` (§8.2)
