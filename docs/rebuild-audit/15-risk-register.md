# 15 · Rebuild risk register

> Formal risk register for the rebuild. Categorised, scored, with mitigations and owners. Update this document as risks materialise or are retired.

---

## Scoring conventions

- **Likelihood** — low (< 10%), medium (10–40%), high (> 40%) over the next 12 weeks.
- **Impact** — low (annoying), medium (slows a phase), high (blocks a phase or breaks production), critical (loses customer trust or money).
- **Categories** — product / tech / deploy / data / UX / adoption / security / agent-control.

---

## Risk register

### R-01 Production differs from `main`

| | |
| --- | --- |
| **Category** | deploy |
| **Likelihood** | high (already realised twice in 3 days) |
| **Impact** | critical |
| **Symptoms** | `buhlos.com` serves a build that `main` doesn't contain. Users hit unexpected pages. PRs landing to `main` don't take effect. |
| **Evidence** | `scripts/check-prod-branch.js` lines 6–21 explicitly document the 2026-05-22 incident. `GUARD_OVERRIDE=YES-I-KNOW` exists and was used. |
| **Mitigation** | Remove `deploy:prod` from `package.json` (done in Phase A). Enforce `main`-only deploy at Vercel project level (server-side guard, not just local). All deploys via merge. Remove `GUARD_OVERRIDE` env support next phase. |
| **Owner / phase** | Phase A (script removal) + Phase B (Vercel project settings lock). |

### R-02 Direct Vercel production deploy

| | |
| --- | --- |
| **Category** | deploy |
| **Likelihood** | high (without guard removal) |
| **Impact** | critical |
| **Symptoms** | A feature branch deploys to `buhlos.com`. |
| **Evidence** | See R-01. |
| **Mitigation** | Same as R-01. Lock Vercel project to `main`-only auto-deploy; disable Vercel CLI prod deploys for non-owner accounts; add per-deploy audit log entry. |
| **Owner / phase** | Phase A + B. |

### R-03 Legacy route collision

| | |
| --- | --- |
| **Category** | tech |
| **Likelihood** | medium (high if discipline lapses) |
| **Impact** | high |
| **Symptoms** | New Next.js page never renders because `vercel.json` rewrite claims the URL first. Or vice-versa: a flipped rewrite blanks the legacy surface. |
| **Evidence** | `vercel.json` claims `/`, `/login`, `/admin/*`, `/buhlos/*`, `/phil`, `/my-day`, etc. Phase A mounted on safe routes (`/command-centre`, `/v2/login`, `/v2/phil`) precisely to avoid this. |
| **Mitigation** | Maintain explicit lists of claimed and safe routes in [14-technical-architecture-deep-dive.md]. Add a `scripts/check-route-collisions.js` guard in Phase B that diffs `vercel.json` against `src/app/**/page.tsx` and fails CI on overlap. |
| **Owner / phase** | Phase B. |

### R-04 Duplicate admin shells

| | |
| --- | --- |
| **Category** | tech / UX |
| **Likelihood** | medium |
| **Impact** | high |
| **Symptoms** | Legacy `_shell.js` shell co-exists with new AdminShell; counts / styles / nav state drift. Users on different admin routes see different chrome. |
| **Evidence** | Three admin architectures in legacy (Phase 1A audit). |
| **Mitigation** | New AdminShell is the only admin chrome under `(admin)` route group. Legacy chrome stays in `public/admin/*.html` until cutover. Lint check: no two files containing `function AdminShell`. |
| **Owner / phase** | All phases — lint rule lives in Phase A `.eslintrc.json`. |

### R-05 Duplicate Phil surfaces

| | |
| --- | --- |
| **Category** | UX / adoption |
| **Likelihood** | high (already realised) |
| **Impact** | high |
| **Symptoms** | PWA manifest `start_url: /my-day` opens legacy tradie home; sidebar nav goes to `/phil` (different surface). Tradies don't know which to use. |
| **Evidence** | `public/manifest.json`, `public/my-day.html`, `public/phil.html` (1,625 lines). |
| **Mitigation** | Phase B Phil hours surface lives at `/phil/my-day` (under `(phil)` group) — manifest `start_url` flips to `/phil/my-day` at Phase B cutover, gated by Phil hours loop being verified for ≥ 1 week. Legacy `/my-day` stays reachable as `/legacy/my-day` for one billing cycle then deletes. |
| **Owner / phase** | Phase B. |

### R-06 Static HTML sprawl

| | |
| --- | --- |
| **Category** | tech |
| **Likelihood** | medium |
| **Impact** | medium |
| **Symptoms** | "I'll just hack a new HTML file in `public/`" pattern recurs. |
| **Evidence** | Legacy has 33 HTML files, 21 web components, two CSS files, 100KB+ inline styles. |
| **Mitigation** | `public/` is static assets only post-Phase-A. `.eslintrc.json` lint rule forbids new HTML in `public/`. PR template asks "is this in `src/`?". |
| **Owner / phase** | Phase A and ongoing. |

### R-07 Broken login redirects

| | |
| --- | --- |
| **Category** | UX / tech |
| **Likelihood** | medium |
| **Impact** | high |
| **Symptoms** | User logs in and lands on a blank page, an infinite redirect, or the wrong surface for their role. |
| **Evidence** | Phase 1A `05-auth-and-permissions-audit.md` covers the legacy redirect chain. Phase A `landingFor()` is one canonical function with vitest unit tests. |
| **Mitigation** | One `landingFor()` implementation (`src/lib/auth/landing.ts`); used by both middleware and login form. Vitest unit tests cover all role categories. Playwright tests cover login → landing round-trip in Phase B. |
| **Owner / phase** | Phase A (function); Phase B (E2E coverage). |

### R-08 Mock data pretending to be real

| | |
| --- | --- |
| **Category** | data / UX |
| **Likelihood** | high (already realised in legacy) |
| **Impact** | critical (users act on fake numbers) |
| **Symptoms** | Page renders fixtures with no indication it isn't live data. Operator approves something based on fake rows. |
| **Evidence** | `public/admin/admin-data.js` defines `window.BUHLOS_MOCK`; `public/admin/operations.html:1670-1692` silently hydrates STATE from it. `public/phil.html` defines `MOCK_JOBS`/`MOCK_AREAS`/`MOCK_TASKS`/`MOCK_HOURS` and falls back to them everywhere. **No DemoModeBanner.** |
| **Mitigation** | `DemoModeBanner` component is mandatory at root layout. `fixtures.isDemoMode()` flag drives it. New `BUHLOS_MOCK`-style silent fallbacks are banned by ESLint `no-restricted-syntax`. Domain fixtures live in `src/domains/<domain>/fixtures.ts` only, never in components. |
| **Owner / phase** | Phase A (banner); all phases (enforcement). |

### R-09 No tests / typecheck

| | |
| --- | --- |
| **Category** | tech |
| **Likelihood** | high (default state of repo) |
| **Impact** | high |
| **Symptoms** | Regressions ship to production. The four `scripts/check-*.js` guards catch only the failure modes that have already been classified. |
| **Evidence** | Zero unit / integration tests in legacy. Six production blank-page incidents in 10 days per `docs/regressions/admin-operations-blank.md`. |
| **Mitigation** | Vitest + Playwright stack added in Phase A. CI workflows (`pr.yml`, `main.yml`) run typecheck + lint + test + build on every PR. `npm run test` is part of the Phase exit criteria. |
| **Owner / phase** | Phase A (tooling); each subsequent phase (coverage growth). |

### R-10 No central data model

| | |
| --- | --- |
| **Category** | tech |
| **Likelihood** | high (default state of repo) |
| **Impact** | high |
| **Symptoms** | Same concept has different shapes in different files. Renaming a field is multi-file shotgun. Drift between client and server. |
| **Evidence** | 86 endpoints with ad-hoc validation; no shared schemas; `OVERVIEW.md` stale relative to `vercel.json`. |
| **Mitigation** | `src/domains/<domain>/{schema,types}.ts` is the single source per entity. Types derive from Zod schemas. Both client and server import the same schema. Lint rule: no `interface` for entities (must derive from `z.infer`). |
| **Owner / phase** | Phase B+ as each domain comes online. |

### R-11 No role enforcement

| | |
| --- | --- |
| **Category** | security / tech |
| **Likelihood** | medium |
| **Impact** | high |
| **Symptoms** | A tradie can hit an admin URL and see admin data, or fire an admin mutation that lacks server-side gating. |
| **Evidence** | Legacy enforces in three places: middleware-style boot redirect, page-level role check, and (sometimes) API check. Drift across the three is the historical bug. |
| **Mitigation** | Three-layer enforcement: `src/middleware.ts` (route), page-level `getCurrentUser()` + `canAccessSurface()` check (UI), server-side `requireAuth()` + role check on every mutation (authoritative). The server check is the only one that matters; the others are UX. |
| **Owner / phase** | Phase A (route + page); Phase B+ (server checks per domain). |

### R-12 Old naming leaking to users

| | |
| --- | --- |
| **Category** | product / adoption |
| **Likelihood** | high (already realised) |
| **Impact** | medium |
| **Symptoms** | A user sees "Site Office" or "Switchboard" as a product label in production. Erodes trust in the rename. |
| **Evidence** | `public/phil.html:1548-1549` shows literal "Site Office portal" text + "Go to Site Office" button. `public/lh-home.html` has "Switch to site office view" link. `public/login.html` page comments + eyebrow text. `localStorage` keys `buhl-site-office-tweaks` + `buhl-site-office-density`. `public/dev/site-office/` folder. 60 hits outside docs. |
| **Mitigation** | ESLint rule rejects deprecated literals in new code. Boot migration deletes legacy `localStorage` keys. Legacy strings are not edited (no touches to `public/*.html`); they go away when the legacy surface is quarantined / deleted post-cutover. |
| **Owner / phase** | Phase A (rule + migration); Phase D–E (per-surface cutover and deletion). |

### R-13 Feature creep

| | |
| --- | --- |
| **Category** | product / agent-control |
| **Likelihood** | high (default for AI-driven work) |
| **Impact** | high |
| **Symptoms** | Phase A grows hours; Phase B grows gear; nothing ships. |
| **Evidence** | Legacy admin grew Job Builder v1 + v2, ITP v1 + v2, Plans v1 + v2, Variations v1 + v2 — half-finished features that became UC-pending and never closed. |
| **Mitigation** | Each phase has a bounded prompt in `docs/rebuild-audit/1{8,9,..}-phase-*-implementation-brief.md`. Coding agents must read [20-agent-rules.md] and refuse out-of-scope work. |
| **Owner / phase** | All phases. |

### R-14 Claude / LLM overbuilding

| | |
| --- | --- |
| **Category** | agent-control |
| **Likelihood** | high (default LLM behaviour) |
| **Impact** | high |
| **Symptoms** | Agent adds nav items, "while I'm here" refactors, plausible-but-unbacked features. |
| **Evidence** | Original Phase A draft conflicted with audit by adding Phil hours; was caught only because the user pushed back. |
| **Mitigation** | [20-agent-rules.md] mandatory pre-read. Every prompt must declare the phase. Agents must stop and ask when the prompt drifts. |
| **Owner / phase** | All phases — enforced by prompt design. |

### R-15 UNDER CONSTRUCTION features appearing complete

| | |
| --- | --- |
| **Category** | product / UX |
| **Likelihood** | medium |
| **Impact** | medium |
| **Symptoms** | A user clicks a nav entry and gets a placeholder that looks live (e.g. "v1" badge but no working flow). |
| **Evidence** | Legacy sidebar has "Job Builder · v1" / "ITP · v1" / etc. with partial flows behind them. |
| **Mitigation** | `UnderConstructionPanel` is the canonical placeholder. Default to UC when unsure (per audit prompt §"Constraints"). UC nav items are non-interactive (`cursor: not-allowed`, no `<Link>`). |
| **Owner / phase** | Phase A (primitive); all phases (enforcement). |

### R-16 Field workers don't adopt Phil if hours flow is slow

| | |
| --- | --- |
| **Category** | adoption |
| **Likelihood** | medium |
| **Impact** | critical (if hours doesn't ship, nothing else matters) |
| **Symptoms** | Tradies open Phil, find Log Hours takes >15s or 5 taps, give up, log on paper. |
| **Evidence** | Legacy `public/phil-hours.html` requires start-time + end-time entry — too many fields for end of day. [[project_buhlos_phil_hours_pipeline]] specifies one-tap "Standard day 7h 36m" + custom fallback. |
| **Mitigation** | Phase B Phil hours flow is gated on <15-second standard-day submission. Playwright test enforces this. |
| **Owner / phase** | Phase B. |

### R-17 Admin doesn't trust data if mock/live states are unclear

| | |
| --- | --- |
| **Category** | adoption / data |
| **Likelihood** | medium |
| **Impact** | high |
| **Symptoms** | Admin sees fixture rows in the queue, treats them as real, then loses confidence in the whole app. |
| **Evidence** | See R-08. |
| **Mitigation** | Same as R-08. DemoModeBanner must be visible whenever fixtures load. |
| **Owner / phase** | Phase A (banner); ongoing. |

### R-18 Route cutover too early

| | |
| --- | --- |
| **Category** | deploy / UX |
| **Likelihood** | medium |
| **Impact** | critical |
| **Symptoms** | `/login` flipped to `/v2/login` before Phil hours has shipped; auth cookie incompatibility surfaces under load; tradies can't log in. |
| **Evidence** | None yet — the discipline is to prevent it. |
| **Mitigation** | Each cutover has explicit preconditions in [16-migration-strategy.md]. Cutovers require: end-to-end test passing in preview, 7-day shadow period, second-human approval. |
| **Owner / phase** | Phase C+ (each cutover). |

### R-19 Backend API retained without validation

| | |
| --- | --- |
| **Category** | security / tech |
| **Likelihood** | medium |
| **Impact** | high |
| **Symptoms** | A legacy endpoint that the new app starts calling accepts malformed input and corrupts a Blob. |
| **Evidence** | Legacy endpoints validate ad-hoc; `api/_lib/validation.js` is partial; full-doc writes against `data.json` are the failure mode (last-write-wins). |
| **Mitigation** | New Phase B+ writes go through `src/domains/<domain>/client.ts` which Zod-parses before sending. Server-side, new endpoints (if added) require Zod. Legacy endpoints retained only for read until Phase D when we start adding patch endpoints. |
| **Owner / phase** | Phase B+ as each domain comes online. |

### R-20 App shell becoming another fake demo

| | |
| --- | --- |
| **Category** | product / agent-control |
| **Likelihood** | medium |
| **Impact** | high |
| **Symptoms** | Phase A shell renders fake KPIs, fake job list, fake worker pictures — accidentally becoming "v3 of the legacy fake demo". |
| **Evidence** | Phase A as built is empty by design — explicit guard. |
| **Mitigation** | [18-phase-a-implementation-brief.md] specifies placeholder-only content. No domain fixtures in Phase A beyond `User` shape. DemoModeBanner is on at all times in Phase A. |
| **Owner / phase** | Phase A. |

### R-21 Audit docs diverging from implementation

| | |
| --- | --- |
| **Category** | agent-control |
| **Likelihood** | medium |
| **Impact** | medium |
| **Symptoms** | Code does one thing; docs say another; next agent makes the wrong call. |
| **Evidence** | `OVERVIEW.md` already stale relative to `vercel.json` (Phase 1A finding). |
| **Mitigation** | Every Phase X completion must update the relevant docs in the same PR. `docs/rebuild-audit/00-executive-summary.md` is updated at each phase boundary. CI script (Phase F) cross-checks doc references against `src/app/**`. |
| **Owner / phase** | All phases. |

### R-22 Service worker shipping stale shell to PWA installs

| | |
| --- | --- |
| **Category** | deploy |
| **Likelihood** | medium |
| **Impact** | high (blank PWA install) |
| **Symptoms** | Update merged to `main`, deployed, but installed PWA clients still see the prior shell because SW cache wasn't bumped. |
| **Evidence** | `public/sw.js` v3 specifically called out as a fix for this in the comments. `scripts/check-sw-cache-version.js` was added to enforce the bump but only catches diff against a previous commit. |
| **Mitigation** | Until Phase G rewrites SW: keep `check-sw-cache-version.js` in CI. After Phase G: Next.js owns its own caching; SW is push-notifications-only. |
| **Owner / phase** | Phase G. |

### R-23 Blob storage hits the wall (concurrency / size)

| | |
| --- | --- |
| **Category** | data |
| **Likelihood** | low (medium at scale) |
| **Impact** | high |
| **Symptoms** | Concurrent admins editing the same job's `data.json` cause silent overwrites. Some blob files growing past 1MB make reads slow. |
| **Evidence** | `POST /api/data?jobId=X` accepts full-document writes. |
| **Mitigation** | Phase D+ writes adopt patch semantics. Phase 2 migration to Postgres (when domain shapes are stable) eliminates this entirely. |
| **Owner / phase** | Phase D (patch); Phase F+ (Postgres). |

### R-24 Cron-driven endpoints break under rebuild

| | |
| --- | --- |
| **Category** | tech |
| **Likelihood** | low |
| **Impact** | medium |
| **Symptoms** | Daily reminder emails stop, stale-snag notifications stop, cash-watch alerts stop because a referenced endpoint shape changed. |
| **Evidence** | 7 crons declared in `vercel.json`. Each calls a specific `api/*` endpoint. |
| **Mitigation** | Don't touch cron endpoints during Phase A–D. Phase E: each rebuild of a cron-dependent endpoint adds a contract test (Vitest) for the cron payload shape. |
| **Owner / phase** | Phase E. |

### R-25 Subcontractor / client portal added prematurely

| | |
| --- | --- |
| **Category** | product / agent-control |
| **Likelihood** | low (medium if agents drift) |
| **Impact** | high |
| **Symptoms** | A future agent builds a client portal in Phase B because "we have `public/client.html` already". |
| **Evidence** | Phase 1A defines client portal as Phase E+. |
| **Mitigation** | Explicit phase scoping in [11-operational-workflow-map.md] and [18-phase-a-implementation-brief.md]. Agent rules require phase declaration. |
| **Owner / phase** | All phases. |

---

## Cross-references

- [10-product-definition.md](10-product-definition.md) — product risks at this layer.
- [16-migration-strategy.md](16-migration-strategy.md) — cutover risks at each gate.
- [17-testing-and-quality-plan.md](17-testing-and-quality-plan.md) — the gates that catch these risks.
- [20-agent-rules.md](20-agent-rules.md) — the agent-control mitigations.
- [06-deployment-audit.md](06-deployment-audit.md) — deploy risk detail from Phase 1A.
- [../regressions/admin-operations-blank.md](../regressions/admin-operations-blank.md) — history of regressions feeding several risks here.
