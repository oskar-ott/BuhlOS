# 00 · Executive summary — Phase 1 rebuild audit

**Date:** 2026-05-22 (Phase 1) + 2026-05-23 (Phase 1B deep audit)
**Branch:** `phase-1-rebuild-audit` (off `claude/wizardly-wright-b1640e`, latest commit `5cdfcaf`); Phase 1B on `phase-1b-rebuild-deep-audit` (from `dcac892`).
**Auditor:** Claude Code (Opus 4.7)
**Scope:** Full audit of the current BuhlOS / Phil codebase as it stands on `main` immediately before a planned ground-up rebuild; Phase 1B adds the rebuild control pack (product definition, workflow map, domain model, IA, technical architecture, risk register, migration strategy, testing plan, per-phase implementation briefs, agent rules, ADR).

---

## TL;DR — the blunt recommendation

> **REBUILD. Do not salvage.**
>
> Keep the *backend* (`api/*` + `api/_lib/*` + Vercel Blob schema) as a temporary backend during the rebuild, and **rebuild the entire frontend from scratch** in a new Next.js + TypeScript + Tailwind app under a new `src/` directory in this same repo.
>
> Do not attempt to migrate the existing `public/*.html` surfaces. Do not attempt incremental rewrites inside `public/admin/*.html` or `public/phil.html`. The frontend has reached a state where every additional change creates new regressions, every deploy is a coin-flip, and the legacy/current/SPA layers compete with each other to be the surface the user sees.
>
> The current frontend is the problem. The current backend is *load-bearing* and largely fine — but it is not the future. We rebuild on top of it, then replace it later.

---

## What this repo actually is (current state, verified)

- **Stack:** Vanilla HTML/CSS/JS in `public/` + Vercel serverless functions (Node 24) in `api/` + Vercel Blob JSON storage.
- **No framework.** No bundler. No TypeScript. No tests. No type checking. No build step.
- **3 different admin architectures coexist** in the same deploy:
  - `public/admin.html` (8,180 lines) — the **legacy** admin, reachable at `/admin-legacy`.
  - `public/admin/operations.html` (3,246 lines) — the **BuhlOS Command Centre SPA**, self-contained, has its own `boot()`.
  - `public/admin/<page>.html` (×24 pages) — the **`_shell.js` multi-page shell** ("site-office shell" in the code), shared sidebar + topbar.
- **2 different Phil architectures coexist:**
  - `public/phil.html` (1,625 lines) — the **new Phil mobile app** with its own MOCK data and `init()`.
  - `public/my-day.html` (2,179 lines) + `public/my-gear.html` + `public/phil-hours.html` — the **legacy tradie surfaces** (still the manifest `start_url` and the tradie post-login redirect target).
- **89 API endpoints** in `api/*.js` — flat file-per-endpoint, no domain folders, no shared schema definitions.
- **`docs/regressions/admin-operations-blank.md`** lists **six separate deploy/blank-page incidents in the last 10 days**, all rooted in the same architectural problems this rebuild is meant to fix.
- **Today (2026-05-22)** is the **second time in three days** the wrong build shipped to `buhlos.com`.

---

## Recommended rebuild strategy

| Layer        | Action                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------- |
| Backend API  | **Keep in place** during rebuild. `api/*.js` + Vercel Blob is the temporary backend.              |
| Auth         | **Keep** the HMAC session cookie + `bcryptjs` PIN/password flow. Wrap in a typed client in the new app. |
| Frontend     | **Rebuild from scratch** in Next.js (App Router) + TypeScript + Tailwind under a new `src/` tree. |
| Routes       | **Replace** `vercel.json` rewrites with native Next.js routes. Retire `/buhlos/*` mirror routes.  |
| Static HTML  | **Quarantine.** Leave existing `public/*.html` reachable as `/legacy/*` so we don't break links during cutover, but new app is the canonical surface. |
| Naming       | **Hard reset.** "BuhlOS" + "Phil" only. "Switchboard" and "Site Office" purged from every user-facing string, file name, localStorage key, code comment, and CSS class. |
| Mock data    | **Move into typed fixtures.** `public/admin/admin-data.js` becomes `src/domains/*/fixtures.ts`.   |
| Tests        | **Introduce.** First time the project has any. Start with route-render smoke tests + auth gate.   |
| Deployment   | **Lock to `main`-only.** Direct `vercel deploy --prod` from local branches is the cause of today's outage. The `check-prod-branch` guard exists but can be skipped with `GUARD_OVERRIDE` — the next phase removes that escape hatch entirely. |

The rebuild is **additive**: the new app boots in parallel with the existing static HTML surfaces. Once the MVP loop (hours) lands end-to-end, we point `vercel.json`'s root rewrite at the new app. The legacy HTML lives at `/legacy/*` for one release cycle and is then deleted.

---

## Should this repo be salvaged, rebuilt, or partially migrated?

**Partially migrated.** The backend is salvageable. The frontend is not.

- **Salvage:** `api/_lib/auth.js`, `api/_lib/blob.js`, `api/_lib/validation.js`, the session cookie format, the Blob key naming convention, the data shapes documented in `OVERVIEW.md`, the bcrypt PIN/password rules, the role taxonomy, the API endpoint set (mostly).
- **Rebuild:** every page in `public/`, every component in `public/components/`, the entire shell+SPA admin architecture, the localStorage key naming, the routing surface, the deploy story.
- **Discard:** `public/admin.html` (legacy 8K-line admin), `public/project.html` (legacy 9.6K-line project page), `public/dev/site-office/`, `public/dev/components/`, every `vercel.json` rewrite that points at static HTML, the `/buhlos/*` mirror routes, the `/my-day`/`/my-gear`/`/phil-hours` parallel Phil surfaces.

---

## Biggest technical risks (in priority order)

1. **Three admin architectures in one deploy.** `admin.html` + `admin/operations.html` SPA + `admin/<page>.html` shell-multi-page. Any change in one can break the others by accident. A pre-deploy smoke test exists for *one* of the three.
2. **Production drift from `main`.** Today's outage was a direct `vercel deploy --prod` from a feature branch — exactly the scenario the `check-prod-branch.js` guard was added to prevent, but the guard can be skipped and was. There is no Vercel-side enforcement.
3. **Service worker v7 is a foot-cannon.** Any change to `_shell.js` / `_shell.css` / `theme.css` / any `public/admin/*.html` must bump `CACHE_VERSION` or installed clients see a stale shell. A pre-deploy check exists but the failure mode is invisible until users complain.
4. **No type safety.** 89 API endpoints + 27 admin HTML pages + 22 web components + a service worker, all sharing JSON shapes by convention. Renaming a field anywhere is a multi-file shotgun-edit. `OVERVIEW.md` is *already* stale relative to `vercel.json`.
5. **Mock data masquerading as live data.** `public/admin/admin-data.js` (`window.BUHLOS_MOCK`) is loaded on every Command Centre boot. If the API returns empty, the user sees fake jobs ("Birdwood IV3232", "Arthur St Warehouse") and may act on them. There is no visual marker distinguishing mock from real.
6. **Full-document writes against Blob.** `POST /api/data?jobId=X` accepts a full replacement of the entire `data.json`. Two concurrent admins editing the same job = last-write-wins, silent overwrites. Blob has no transactions.
7. **89 endpoints with no shared schema.** Each `api/*.js` does its own ad-hoc validation. Drift between what the client expects and what the server accepts is invisible until runtime.
8. **No tests.** Zero unit tests, zero integration tests. The only "tests" are the four `scripts/check-*.js` static-string assertions that block deploys. Most failure modes have no automated detection.

---

## Biggest product risks (in priority order)

1. **Half-built features pretending to be live.** The Command Centre sidebar shows "Job Builder · v1", "ITP · v1", "Plans · v1", "Variations · v1" — these render content but the underlying flows are partial. Quotes and Reports are marked `uc` (under construction) but Materials, Assets, Variations are *not* marked despite being equally incomplete. Per [[feedback_hide_unfinished_features]]: half-broken UI must be hidden or labelled, never shipped live.
2. **Two parallel Phil surfaces.** `/phil` (new) and `/my-day`+`/my-gear`+`/phil-hours` (legacy). PWA `start_url` still points at `/my-day`. Tradie post-login redirects to `/my-day`, not `/phil`. The user has no idea which surface is canonical.
3. **"Site Office" still rendered to users.** `public/phil.html:1548-1549` shows literal "Site Office portal" text to a client who lands in Phil, with a "Go to Site Office" button. Per [[project_buhlos_phil_naming]] this is a hard naming-rule violation in production.
4. **localStorage key `buhl-site-office-tweaks`** persists deprecated naming on every admin device. A future rename requires a migration step.
5. **`/jobs` and `/admin/jobs` both go to the same `admin/jobs.html` page.** Confusing routing surface — what is `/jobs` for?
6. **`/buhlos/*` mirror of every `/admin/*` route.** Doubles the deploy contract. No clear product reason; it appears to be a guess about future URLs.
7. **Hours pipeline ([[project_buhlos_phil_hours_pipeline]]) is the only end-to-end loop.** Everything else is admin-builds-thing-and-shows-it-to-admin. The Phil → admin → approval → audit-log chain only exists for timesheets.
8. **No tradie-side UX for ITP, RFI, defects, evidence capture.** Phil today is "see jobs, log hours, see gear" — none of the field-evidence capture that the rebuild target requires.

---

## Biggest deployment risks (in priority order)

1. **`buhlos.com` was wrong twice in 3 days.** 2026-05-20 and 2026-05-22. Both were direct `vercel deploy --prod` from feature branches. The bypass exists (`GUARD_OVERRIDE=YES-I-KNOW`) and was used.
2. **No CI.** All "checks" are local-machine pre-deploy hooks. Anyone with Vercel access can bypass them.
3. **Service worker cache mismatch can ship blank** to existing PWA installs even when the new HTML is correct. `check-sw-cache-version.js` checks the bump but not whether it was actually wired through.
4. **The `/admin/operations` SPA boot path is ~10 layers deep** (vercel rewrite → login redirect → admin/index.html JS redirect → operations.html → splash → /api/auth?action=me → role gate → fan-out fetches → mock fallback → render). Any one layer failing renders blank.
5. **Two architectures sharing one cache.** The SW caches `_shell.js` which only the multi-page admin uses, but every admin nav passes through the same SW. The Command Centre SPA has its own boot that doesn't need `_shell.js` but the SW still caches it for *all* admin pages.
6. **Cron-driven endpoints** (`vercel.json` `crons` field) fire whether or not the corresponding feature is wired. `api/notifications?action=send-daily-reminders` runs at 05:30 Mon-Fri — but the rebuild may change the data shape underneath it. We need to inventory which crons can break which features.

---

## Is the current repo suitable as the new foundation?

**Yes — as the repo container.** Not as the codebase.

Keep:
- The git history (don't start a fresh repo — we want the audit trail).
- The Vercel project + domain (`buhlapp.xyz` for testing, `buhlos.com` for prod).
- The `api/*` backend (temporary, replaced later).
- The blob storage + env vars (`SESSION_SECRET`, `BLOB_READ_WRITE_TOKEN`).
- `package.json` (extend with TS / Next / Tailwind deps).

Treat the existing frontend as legacy code we are gradually retiring. Do not rewrite a single line of `public/admin/*.html`. Do not touch `public/phil.html`. New code lives in a new `src/` tree.

---

## What should be kept

| Item                                       | Why                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `api/_lib/auth.js`                         | HMAC session cookie + role gate is sound. Wrap in a TS client.                       |
| `api/_lib/blob.js`                         | Blob R/W helper is fine. May get replaced by Postgres later but works for MVP.       |
| `api/_lib/validation.js`                   | nanoid + shape validators we'll keep using.                                          |
| The role taxonomy                          | admin / leadingHand / tradie / client / apprentice / + admin-capable expansion.      |
| The Blob key naming convention             | `users.json`, `jobs.json`, `jobs/{id}/data.json`, etc. Stable and grep-friendly.      |
| The hours-pipeline data model              | The one feature that's actually wired end-to-end. Document and keep its schema.       |
| `OVERVIEW.md` (as a starting point only)   | It's stale, but the data shapes documented there are still the right starting point. |
| `docs/regressions/admin-operations-blank.md` | Institutional memory. Carry forward and link to from the rebuild docs.             |
| `docs/deploy-checklist.md`                 | Salvage the strict deploy rules; rewrite the surface-specific bits.                  |
| The `BUHL_LOGO.png` + icon set             | Brand assets. Logo V3 per [[project_phil_logo_v3]] still applies for Phil.           |

---

## What should be rebuilt

| Item                                                        | Why                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------ |
| The entire admin surface (`public/admin/*.html` + `_shell.js`) | Three-architecture coexistence is unfixable in place.    |
| The Phil mobile app (`public/phil.html`)                    | Will become `src/app/phil/*` with proper routing.            |
| The login flow (`public/login.html`)                        | Becomes `src/app/login/page.tsx`. Reuses the same `api/auth.js`. |
| The leading-hand home (`public/lh-home.html`)               | Becomes `src/app/(admin)/lh/*` or merged into admin surface. |
| Web components in `public/components/`                      | Replaced by React components in `src/components/`.           |
| Shared styles (`public/theme.css`)                          | Tokens become Tailwind config; components become composable. |
| The service worker                                          | Stop SW-caching the shell entirely. Next.js handles its own caching. Keep push handling. |
| The vercel.json rewrites                                    | Most disappear when Next.js owns routing.                    |

---

## What should be discarded

| Item                                       | Why                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `public/admin.html` (legacy 8,180-line admin) | Dead surface. Reachable at `/admin-legacy` only; no traffic.                       |
| `public/project.html` (legacy 9,599-line page) | Was the OLD `/jobs/:id`. Replaced by the new admin job page.                       |
| `public/dev/site-office/*`                 | Deprecated naming. Discovery surface, not a product surface.                         |
| `public/dev/components/*`                  | Component playground. Will be replaced by Storybook or similar if needed.            |
| `/buhlos/*` rewrites in `vercel.json`      | Mirror of `/admin/*`. No traffic justifies the doubled deploy surface.               |
| `/dev/*` rewrites                          | Internal-only paths that should never have been in `vercel.json`.                    |
| `/admin-legacy` rewrite                    | Pointer at the legacy admin. Delete the admin, delete the rewrite.                   |
| `/overview` rewrite                        | Alias for `/admin/operations`. Confusing. One canonical name only.                   |
| `localStorage` key `buhl-site-office-tweaks` | Deprecated naming. Migration script needed.                                        |
| `public/admin/admin-data.js` (mock data)   | Move into typed fixtures in `src/domains/*/fixtures.ts`. Mock vs real must be visibly distinct. |

---

## Final blunt recommendation

The current frontend has crossed the point where every additional vibe-coded change makes the next change harder. Three admin architectures, two Phil architectures, deprecated naming still rendered to users, `buhlos.com` wrong twice in three days, zero type safety, zero tests, mock data that pretends to be live, and a 9-step boot chain that breaks at any layer.

**Do the rebuild.** The path is in [[01-target-rebuild-structure]] and [[01-mvp-rebuild-scope]]. The first slice is one operational loop end-to-end (hours, per [[project_buhlos_phil_hours_pipeline]]) on the new shell, with the old shell still serving every other feature. After hours lands, we slice the next loop (gear), then the next (evidence), then ITPs, then RFIs. Each slice ships behind a flag and only takes over a route when verified.

Do not deploy until:
1. The new shell renders on a preview URL.
2. The hours loop lands end-to-end on the new shell.
3. `main`-only deploys are enforced server-side (Vercel project settings), not just by the local guard.
4. A second human has eyeballed the production deploy.

The next prompt for Claude Code is at `docs/rebuild-audit/08-next-claude-code-prompt.md`.

---

## Phase 1B — deep audit (2026-05-23)

### Why Phase 1B was added

Phase 1 produced the diagnosis and the recommended rebuild strategy. It did **not** produce the operational specifics future coding agents would need to avoid rebuilding another generic SaaS demo. During the first Phase A session, the user's directive to "focus on Phil hours first" conflicted with the audit's Phase-A-is-foundation-only scope; the conflict was surfaced but exposed that the audit pack needed deeper anchoring documents so coding agents can't drift toward generic-dashboard patterns or skip phases.

Phase 1B is that deeper pack. It is documentation-only — **no runtime or app code changed**. It produces 14 new docs and updates 2 existing docs under `docs/rebuild-audit/`.

### Top 5 rebuild conclusions

1. **The product is not a generic SaaS dashboard.** BuhlOS is an electrical-contracting operating backbone. BuhlOS Admin is queue-oriented control; Phil is field capture. The home is queues that need a decision, not vanity KPIs. See [10-product-definition.md](10-product-definition.md).
2. **Closed loops drive the phases.** Hours is the first loop end-to-end (Phil capture → admin approve → CSV export); gear is second; jobs + evidence is third. Reporting / intelligence aggregates over loops, not the other way round. See [11-operational-workflow-map.md](11-operational-workflow-map.md).
3. **Coexistence over cutover.** New routes mount on non-colliding paths (`/command-centre`, `/v2/login`, `/v2/phil`); legacy `vercel.json` rewrites stay until each cutover passes its precondition gate (preview verified, 7-day shadow, second-human approval). See [16-migration-strategy.md](16-migration-strategy.md).
4. **Domain-led, not UI-led.** Every shape that touches the API has a Zod schema in `src/domains/<x>/schema.ts`; pages compose, domains carry logic. The legacy "ad-hoc objects per page" pattern is banned. See [12-domain-model-deep-dive.md](12-domain-model-deep-dive.md) and [14-technical-architecture-deep-dive.md](14-technical-architecture-deep-dive.md).
5. **Agent control is a first-class concern.** Future coding agents have explicit rules ([20-agent-rules.md](20-agent-rules.md)), explicit phase briefs ([18](18-phase-a-implementation-brief.md), [19](19-phase-b-hours-implementation-brief.md)), and explicit binding decisions ([21](21-rebuild-decision-record.md)). When a prompt drifts, the agent must stop and ask — not silently obey.

### Recommended next action

1. Review the Phase 1B audit pack (start from [23-rebuild-index.md](23-rebuild-index.md)).
2. Commit the 14 new + 2 updated docs as a single docs-only commit on `phase-1b-rebuild-deep-audit`.
3. PR `phase-1b-rebuild-deep-audit → main` first (docs only; low risk).
4. PR `phase-a-app-shell → main` second (the foundation built earlier in the session as commit `a49dc82`).
5. Start Phase B using [19-phase-b-hours-implementation-brief.md](19-phase-b-hours-implementation-brief.md) as the prompt.

### Links to the new docs

- [10-product-definition.md](10-product-definition.md)
- [11-operational-workflow-map.md](11-operational-workflow-map.md)
- [12-domain-model-deep-dive.md](12-domain-model-deep-dive.md)
- [13-ui-information-architecture.md](13-ui-information-architecture.md)
- [14-technical-architecture-deep-dive.md](14-technical-architecture-deep-dive.md)
- [15-risk-register.md](15-risk-register.md)
- [16-migration-strategy.md](16-migration-strategy.md)
- [17-testing-and-quality-plan.md](17-testing-and-quality-plan.md)
- [18-phase-a-implementation-brief.md](18-phase-a-implementation-brief.md)
- [19-phase-b-hours-implementation-brief.md](19-phase-b-hours-implementation-brief.md)
- [20-agent-rules.md](20-agent-rules.md)
- [21-rebuild-decision-record.md](21-rebuild-decision-record.md)
- [22-phase-1b-command-results.md](22-phase-1b-command-results.md)
- [23-rebuild-index.md](23-rebuild-index.md)

### Warning

> **Phase A must not start until Phase 1B is committed.** The Phase A implementation brief ([18](18-phase-a-implementation-brief.md)) requires the 1B docs as pre-read. Starting Phase A without them re-introduces R-13 (feature creep) and R-14 (LLM overbuilding) from [15-risk-register.md](15-risk-register.md).
