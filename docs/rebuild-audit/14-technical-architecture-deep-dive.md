# 14 · Technical architecture deep dive

> Target technical architecture, the legacy diagnosis it must coexist with, and the rules every new file must obey. This document is binding for every code-writing session that follows.

---

## A. Current technical diagnosis

### Repo shape (as of `dcac892`, on `phase-1-rebuild-audit`)

| Layer | Reality |
| --- | --- |
| Stack | Vanilla HTML/CSS/JS in `public/` + Vercel serverless functions (Node 24) in `api/` + Vercel Blob JSON storage. |
| Build step | **None.** No bundler, no transpiler, no TS, no tests. |
| Frontend surfaces | 33 HTML pages: 10 root + 23 admin. **Three admin architectures coexist** (legacy `admin.html` 8,180 lines, Command Centre SPA `admin/operations.html` 3,246 lines, multi-page shell `admin/<page>.html` × 22). **Two Phil architectures coexist** (`phil.html` 1,625 lines vs `my-day.html`/`my-gear.html`/`phil-hours.html`). |
| Frontend components | 21 web-component-style files in `public/components/` (`workspace-shell.js`, `cmd-palette.js`, `area-card.js`, ...) and 2 in `public/lib/`. |
| Styles | `public/css/buhlos.css`, `public/css/buhlos-admin.css`, plus inline `<style>` blocks in many HTML pages (100KB+ total per Phase 1A audit). |
| Backend | **86 endpoints** in `api/*.js` (flat file-per-endpoint; no domain folders). |
| Backend libs | `api/_lib/auth.js` (HMAC session), `api/_lib/blob.js` (Vercel Blob R/W), `api/_lib/validation.js` (nanoid + shape checks), `api/_lib/time-entries.js` (the well-formed hours model), `api/_lib/activity.js`, `api/_lib/job-tasks.js`, `api/_lib/job-audit.js`, `api/_lib/push.js`. |
| Persistence | Vercel Blob JSON. Keys include `users.json`, `jobs.json`, `jobs/{id}/data.json`, `users/{userId}/time-entries/{date}.json`. |
| Auth | HMAC session cookie `buhl_session` set by `api/auth.js`, verified per-request by `api/_lib/auth.js`. `bcryptjs` for password + PIN. |
| Routing | `vercel.json` with **~70 rewrites** mapping URL → static HTML. `/admin/*`, `/buhlos/*` (mirror), `/jobs`, `/lh`, `/my-day`, `/my-gear`, `/phil`, `/client`, `/install`, `/dev/*`, `/admin-legacy`. Rewrites run before any framework. |
| PWA | `public/manifest.json` (`start_url: "/my-day"`), `public/sw.js` (v5 cache, stale-while-revalidate for admin shell, no API caching, push notifications). |
| Mock data | `public/admin/admin-data.js` defines `window.BUHLOS_MOCK` (Job Builder templates). `public/admin/operations.html` silently hydrates STATE from it when API empty. `public/phil.html` defines `MOCK_JOBS`, `MOCK_AREAS`, `MOCK_TASKS`, `MOCK_HOURS` and falls back to them everywhere `APP.jobs/hours/etc.` is unset. **No DemoModeBanner.** |
| localStorage | 12 files write to localStorage. Deprecated `buhl-site-office-tweaks` (TWEAK_KEY in `_shell.js`) and `buhl-site-office-density` (DENSITY_KEY in `workspace-shell.js`) still active. |
| Env vars | 20 referenced in `api/`+`scripts/` (`SESSION_SECRET`, `BLOB_READ_WRITE_TOKEN`, `VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT`, `ANTHROPIC_API_KEY`, `PLANS_AI_*`, `RESEND_API_KEY`, `CRON_SECRET`, `ADMIN_ALERT_EMAIL`, `SNAG_EMAIL_FROM`, `GUARD_OVERRIDE`, `DRY_RUN`, `BLOB_CACHE_DISABLE`, `NEW_PIN`, `USERNAME`, `ADMIN_USER_ID`). No central validation. |
| Deploy | `package.json` exposes `deploy:prod: "vercel deploy --prod --yes"` and `deploy:preview: "vercel deploy --yes"`. `predeploy:prod` runs `check-prod-branch.js` which blocks unless on `main` ancestor — but it can be skipped with `GUARD_OVERRIDE=YES-I-KNOW`, and that override was exercised twice in three days. |
| Tests | **Zero.** The only "tests" are the four `scripts/check-*.js` static-string assertions. |
| Crons | 7 declared in `vercel.json` `crons[]`: daily reminders Mon–Fri 05:30, weekly tag reminders Sun 22:00, daily digest Mon–Fri 07:00, stale snags Sun 23:00, inactive users Mon 23:00, cash watch daily 22:30, user sweep daily 19:00. |

### Risks rolled forward from this shape

1. **Three admin architectures in one deploy** — any change in one can break the others by accident. Pre-deploy smoke covers only `/admin/operations`.
2. **Two Phil architectures** — manifest `start_url` still `/my-day`; tradie post-login redirects to `/my-day`, not `/phil`.
3. **Production drift from `main`** — `vercel deploy --prod` from feature branches; `GUARD_OVERRIDE` escape hatch exists and was used.
4. **Service worker v5 footgun** — any change to `_shell.js`, `_shell.css`, `theme.css`, or `admin/*.html` must bump `CACHE_VERSION` or installed clients see stale shell.
5. **No type safety** — 86 endpoints + 23 admin pages + 21 components share JSON shapes by convention; `OVERVIEW.md` already stale relative to `vercel.json`.
6. **Mock data masquerading as live** — `window.BUHLOS_MOCK` injected silently. `MOCK_JOBS`/etc. in `public/phil.html`.
7. **Full-document writes against Blob** — `POST /api/data?jobId=X` accepts a full replacement of `data.json`. Concurrent admins editing same job = last-write-wins.
8. **No CI** — all checks are local pre-deploy hooks bypassable via env var.

---

## B. Target architecture

### Stack (Phase A baseline)

| Layer | Choice | Rationale |
| --- | --- | --- |
| Framework | Next.js 15+ App Router | Server components, native routing, edge middleware for auth gates, file-system-based routing eliminates `vercel.json` route sprawl over time. |
| Language | TypeScript (strict) | Catch shape drift the current repo can't. `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, no `any`. |
| Styling | Tailwind CSS v3+ with brand tokens in `src/styles/tokens.css` | Replaces 100KB+ inline `<style>` blocks; tokens for brand consistency. |
| State | React Server Components + React Query (TanStack) | Server-render admin; client-side caching for Phil; no global state lib. |
| Forms | React Hook Form + Zod resolvers | Typed forms with shared validators. |
| Validation | Zod | Same schemas client + server. |
| Dates | `date-fns` | Small, tree-shakeable. |
| Icons | `lucide-react` | One consistent icon set; replaces 22-component web-component sprawl. |
| Tests | Vitest (unit) + Playwright (E2E) | Vitest for fast domain tests; Playwright for the hours loop and route smoke. |
| Backend (Phase 1) | Existing `api/*.js` serverless functions | Don't touch the working backend until UI rebuild lands. |
| Backend (Phase 2) | Postgres + Drizzle (preferred) or Prisma | Replaces Blob when domain shapes have matured. |
| Auth (transition) | Existing HMAC cookie via `api/_lib/auth.js` | Wrapped in TS client; migration path to Auth.js later if needed. |
| Deployment | Vercel | Existing project; no migration risk. |
| CI | GitHub Actions: `pr.yml`, `main.yml` | Typecheck + lint + test + build + legacy guards on every PR. |
| Node | 24.x (matches existing `engines`) | Production parity. |

### Non-stack choices made explicitly

- **No global state library.** No Redux, Zustand, Jotai. React Query handles data; React Context handles cross-component state; URL state for filters and tabs.
- **No GraphQL.** REST endpoints continue; typed clients in `src/domains/*/client.ts` wrap them.
- **No CSS-in-JS runtime.** Tailwind utilities + tokens only. No styled-components, no emotion.
- **No client-side routing library.** Next.js App Router only.

---

## C. App structure

```
src/
├── app/                              # Next.js App Router routes
│   ├── layout.tsx                    # Root — Inter + Inter Tight, DemoModeBanner, error boundary
│   ├── page.tsx                      # `/` — getCurrentUser() → landingFor()
│   ├── error.tsx                     # Global error boundary
│   ├── not-found.tsx                 # 404
│   ├── v2/
│   │   ├── login/
│   │   │   ├── page.tsx              # /v2/login — parallel to legacy /login
│   │   │   └── login-form.tsx        # client component, posts /api/auth?action=login
│   │   └── phil/
│   │       ├── layout.tsx            # PhilShell wrapper
│   │       ├── page.tsx              # /v2/phil — Phase A placeholder + UC for hours
│   │       ├── my-day/page.tsx       # Phase B: today's hours capture
│   │       ├── hours/page.tsx        # Phase B: my hours history
│   │       ├── gear/page.tsx         # Phase C
│   │       └── jobs/
│   │           ├── page.tsx
│   │           └── [jobId]/page.tsx
│   ├── (admin)/                      # Route group — admin surface
│   │   ├── layout.tsx                # AdminShell wrapper
│   │   ├── command-centre/page.tsx   # /command-centre — replaces /admin/operations
│   │   ├── hours/
│   │   │   ├── page.tsx              # /hours — overview (Phase B)
│   │   │   └── approvals/page.tsx    # /hours/approvals — review queue (Phase B)
│   │   ├── jobs/                     # Phase D
│   │   ├── gear/                     # Phase C
│   │   ├── snags/                    # Phase D
│   │   ├── plans/                    # Phase E
│   │   ├── itp/                      # Phase E
│   │   ├── rfis/                     # Phase E
│   │   ├── materials/                # Phase E
│   │   ├── variations/               # Phase E
│   │   ├── reports/                  # Phase F
│   │   ├── settings/                 # Phase E
│   │   ├── people/                   # Phase D
│   │   ├── support/                  # Phase E
│   │   └── activity/                 # Phase D
│   ├── (client)/                     # Route group — Client portal (Phase E+)
│   │   ├── layout.tsx
│   │   └── client/
│   │       └── jobs/[jobId]/page.tsx
│   └── api/                          # NEW Next.js API routes (gradual; legacy api/ stays)
│       └── (none initially)
│
├── components/
│   ├── ui/                           # Primitives: Button, Card, Pill, StatusBadge, EmptyState,
│   │                                 # Modal, UnderConstructionPanel, DemoModeBanner
│   ├── admin/                        # Admin shell + admin-specific composites
│   │   ├── AdminShell.tsx            # Sidebar + topbar layout
│   │   ├── AdminSidebar.tsx
│   │   ├── AdminTopbar.tsx
│   │   └── ...
│   ├── phil/                         # Phil shell + Phil-specific composites
│   │   ├── PhilShell.tsx             # Bottom-tab layout
│   │   ├── PhilTabBar.tsx
│   │   ├── PhilHeader.tsx
│   │   ├── LogHoursSheet.tsx         # Phase B — "Standard day 7h 36m"
│   │   └── ...
│   └── shared/                       # Used by both
│
├── domains/                          # ONE folder per business entity
│   ├── jobs/                         # Phase D
│   ├── timesheets/                   # Phase B (FIRST domain implemented)
│   ├── workers/                      # Phase B
│   ├── gear/                         # Phase C
│   ├── evidence/                     # Phase D
│   ├── snags/                        # Phase D
│   ├── plans/                        # Phase E
│   ├── itp/                          # Phase E
│   ├── rfis/                         # Phase E
│   ├── materials/                    # Phase E
│   ├── variations/                   # Phase E
│   ├── alerts/                       # Phase F
│   ├── audit-log/                    # Phase D (cross-cutting)
│   └── organisation/                 # implicit
│
├── lib/                              # Cross-cutting framework code
│   ├── auth/
│   │   ├── session.ts                # cookie decode + /api/auth?action=me wrapper
│   │   ├── current-user.ts           # getCurrentUser()
│   │   ├── landing.ts                # landingFor() — canonical
│   │   ├── roles.ts                  # Role types + ADMIN_ROLES/FIELD_ROLES arrays
│   │   ├── permissions.ts            # canAccessSurface() + per-feature checks (Phase B+)
│   │   └── middleware.ts             # used by src/middleware.ts
│   ├── db/                           # placeholder for Phase 2 Postgres
│   ├── storage/
│   │   ├── blob.ts                   # typed wrapper for Vercel Blob
│   │   └── migrate-local-storage.ts  # one-time boot migration (deletes legacy keys)
│   ├── validation/
│   │   └── zod-helpers.ts            # nanoid refinement, date-string refinement
│   ├── env.ts                        # Zod-validated process.env access
│   ├── http.ts                       # typed fetch wrapper
│   ├── flags.ts                      # feature flags + fixtures.isDemoMode()
│   └── cn.ts                         # tailwind-merge + clsx helper
│
├── middleware.ts                     # Route gating (calls lib/auth/middleware.ts)
│
├── styles/
│   ├── tokens.css                    # Brand tokens (--accent-yellow, --brand-navy, ...)
│   └── globals.css                   # Tailwind directives + small global resets
│
├── types/
│   └── index.ts                      # Truly global type helpers (AsyncResult, Nominal, ...)
│
└── data/
    └── mock/                         # Phase A only — typed seed data when domain fixtures don't exist yet
```

### What lives outside `src/` (legacy quarantine)

```
public/        — static assets only after rebuild completes (icons, manifest, sw.js)
               — during transition, ALL existing *.html files stay reachable via vercel.json
api/           — existing serverless functions (kept Phase A–D, gradually moved to src/app/api/)
scripts/       — existing pre-deploy guards + maintenance scripts (kept)
docs/          — audit + architecture + product + runbooks
```

### Routes that must NOT collide (rebuild owns these without rewrite)

`/command-centre`, `/v2/login`, `/v2/phil`, `/v2/phil/*`, `/hours`, `/hours/approvals`, `/gear`, `/people`, `/itp`, `/plans`, `/materials`, `/rfis`, `/snags`, `/reports`, `/settings`, `/support`, `/activity`. None of these appear in `vercel.json` rewrites.

### Routes still owned by `vercel.json` (NEVER mount Next.js pages on these in Phase A–E)

`/`, `/login`, `/jobs`, `/jobs/:jobId`, `/jobs/:jobId/log-hours`, `/admin`, `/admin/*`, `/buhlos`, `/buhlos/*`, `/phil`, `/phil/app`, `/phil/login`, `/my-day`, `/my-gear`, `/phil-hours`, `/lh`, `/lh-home`, `/approvals`, `/overview`, `/install`, `/client`, `/client/jobs/:jobId`, `/admin-legacy`, `/dev/*`.

---

## D. Coexistence rules

1. **The new app must not break the legacy app.** Every Phase A–E PR must keep `check:admin-shell` / `check:sw-cache-version` / `check:production-shell` / `smoke:admin-routes` passing.
2. **No `vercel.json` rewrite is flipped in Phase A.** Even `/install` (claimed by `vercel.json`) stays on legacy until Phase E or later.
3. **`/login` cutover requires:**
   - Phase B hours loop is shipping reliably via the legacy login (proving `/v2/login` cookie is compatible).
   - Playwright tests cover the new login end-to-end against a deployed preview.
   - Boss + admin sign-off on the change.
4. **`/admin` cutover requires:**
   - Hours loop AND at least one more admin workflow shipping via `/command-centre`.
   - All four `scripts/check-*.js` guards passing against the new admin too.
   - 7-day shadow period where both surfaces are reachable.
5. **`/phil` cutover requires:**
   - PWA manifest update (`start_url` flips to `/phil/my-day`).
   - Service worker cache bumped + tested across installed clients.
   - Phil hours + Phil gear loops both shipping.
6. **Legacy routes are deleted only after** the new route has been in production for at least one billing cycle (~4 weeks) without regression.
7. **Existing API endpoints can be consumed but not rewritten** until their domain is being touched. `api/time-entries.js` is consumed by Phase B unchanged.
8. **`vercel.json` rewrites are only ever removed in order of phase completion.** Never deleted "while we're at it".

---

## E. Code rules

These are binding for every file under `src/`:

### Architecture rules

- **No business logic in page components.** `src/app/<route>/page.tsx` composes; `src/domains/<domain>/` contains logic.
- **No new static HTML primary surfaces.** Repeat of [00-rebuild-non-negotiables.md] §UI. New surfaces are React.
- **No silent mock fallback.** If fixtures load, `DemoModeBanner` is visible. `fixtures.isDemoMode()` exists for this.
- **No UI-only random data structures.** Every shape that touches the API has its schema in `src/domains/<domain>/schema.ts`. Types derive from schemas.
- **Domain logic stays in `src/domains/<domain>/`.** No "I'll just put the cost calc in the page" exceptions.
- **One canonical source per concept.** No two `landingFor()` implementations. No two `JobHeader` components. No two CSS files both defining `--accent-yellow`.

### API + persistence rules

- **All mutations validate input with Zod** at the API boundary. Server-side rejection is authoritative; client-side validation is convenience.
- **All role-sensitive actions need permissions checks at three layers:** middleware (route gate), page (UI hide), API (server-side check). The API check is authoritative.
- **No full-document writes for grow-collections** in new code. The existing full-doc writes on `/api/data` are tolerated during transition but new endpoints get patch semantics.
- **No mock-only endpoints.** `src/app/api/<x>/route.ts` either does real work or returns 501.

### UI rules

- **No `alert()` / `confirm()` / `prompt()`** in product code. Use Modal / banner / inline error.
- **No `document.body.innerHTML = ...`** page replacement. Use React.
- **No `window.location.href = ...`** for in-app nav. Use `<Link>` / `useRouter()`. Hard navigation only for external links and explicit logout.
- **No inline `<style>` blocks** in component files. Tailwind utilities + tokens only.
- **No emojis** in product UI unless design explicitly calls for them. No emojis in code comments.

### Naming hygiene rules

- **No user-facing "Switchboard" or "Site Office"** as product labels. Electrical-equipment usage of "switchboard" is fine.
- **No localStorage keys with deprecated names.** New code never writes `buhl-site-office-*`. The boot migration in `src/lib/storage/migrate-local-storage.ts` removes legacy keys.
- **No file or folder named `site-office`** anywhere in `src/`.
- **No code comments saying "site office"** in active code.

### Performance + bundle rules

- **No file >100KB** in `src/` without a clear reason. Legacy has 10+ files over 100KB; rebuild keeps none.
- **No "one big component" files.** Pages compose multiple components, each in its own file.
- **No global `window` state** — use React state, context, or React Query at the layer that owns the state.

### Testing rules

- **Every domain has a test file.** `src/domains/timesheets/timesheets.test.ts` exists from the moment timesheets does.
- **Every route has a render smoke test** (Playwright preferred for routes, `@testing-library/react` acceptable for components).
- **Every API route has an integration test** covering at least the happy path and an unauthorised-call path.
- **The hours loop has an end-to-end test** — Phil → admin → approval. The reference loop; must always pass.

### Audit + observability rules

- **Every mutation writes to `AuditLog`** with `{ actor, action, target, timestamp, before?, after? }`.
- **Every permission denial writes to `AuditLog`** with `{ actor, attempted_action, target, reason, timestamp }`.
- **Every production error gets a unique error ID** shown to the user and recorded server-side.

### Backwards compatibility rules

- **Old session cookies remain valid.** `SESSION_SECRET` and cookie format unchanged. New app reads the same `buhl_session` cookie.
- **Old Blob keys remain readable.** New writes may use new keys, but old keys are not silently abandoned.
- **Old roles remain understood.** A user with `role: 'leadingHand'` in `users.json` continues to work.

---

## F. Future integration boundaries

These integrations are documented now so the domain model can leave room for them without designing them today.

### Xero (payroll + invoicing)

- **Scope:** Push approved week of hours per worker; pull payroll batch IDs.
- **Owner of contract:** Xero.
- **Status in repo:** none.
- **Phase:** F+.
- **Risk:** API contract not yet known; build the domain assuming it lands in Phase F.

### ServiceM8

- **Scope:** Field-service alternative under consideration; we are NOT integrating with it — we are *replacing* the part the customer currently uses for hours.
- **Status:** none in repo.
- **Phase:** N/A (no integration planned).

### Google Sheets

- **Scope:** Legacy hours-and-payroll spreadsheet. CSV export from BuhlOS will replace it.
- **Status:** out of scope for code; CSV export is sufficient.
- **Phase:** B (CSV ships).

### Vercel Blob / Vercel storage

- **Scope:** Current persistence. Continues until Phase 2 Postgres migration.
- **Owner:** us.
- **Phase:** F+ to migrate; until then, typed wrapper at `src/lib/storage/blob.ts`.

### AI plan interpretation (Anthropic)

- **Scope:** Estimator-facing PDF interpretation. Existing infra in `api/plans.js` with `ANTHROPIC_API_KEY`, `PLANS_AI_MODEL`, cost guards (`PLANS_AI_INPUT_USD_PER_MTOK`, `PLANS_AI_OUTPUT_USD_PER_MTOK`, `PLANS_MAX_USD_PER_JOB`).
- **Owner:** us, calling Anthropic.
- **Phase:** F+ rebuild UI; existing endpoints retained.

### Payroll export

- **Scope:** CSV format aligned to whatever Xero or current payroll system expects.
- **Phase:** B (CSV); F+ (direct push).

### Reporting / intelligence

- **Scope:** Materialised views over the audit log + entity tables.
- **Phase:** F+. Cannot be built until domains have produced ≥4 weeks of real data.

### Push notifications (existing)

- **Scope:** Web Push to PWA installs (`api/notifications.js`, `api/push-test.js`, `public/sw.js`).
- **Env:** `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`.
- **Phase:** kept as-is in Phase A–D; rebuilt in Phase F when SW is rewritten.

### Email (Resend)

- **Scope:** Snag notifications, alerts. Env: `RESEND_API_KEY`, `ADMIN_ALERT_EMAIL`, `SNAG_EMAIL_FROM`.
- **Phase:** kept as-is; typed client added in Phase D when snags rebuild.

---

## Cross-references

- [10-product-definition.md](10-product-definition.md) — what we're building.
- [12-domain-model-deep-dive.md](12-domain-model-deep-dive.md) — schemas the code depends on.
- [13-ui-information-architecture.md](13-ui-information-architecture.md) — IA that consumes this architecture.
- [16-migration-strategy.md](16-migration-strategy.md) — phase ordering for surface cutovers.
- [17-testing-and-quality-plan.md](17-testing-and-quality-plan.md) — gates each phase must pass.
- [../architecture/00-rebuild-non-negotiables.md](../architecture/00-rebuild-non-negotiables.md) — binding rules (this doc expands them).
- [../architecture/01-target-rebuild-structure.md](../architecture/01-target-rebuild-structure.md) — Phase 1A folder structure (this doc supersedes).
- [06-deployment-audit.md](06-deployment-audit.md) — deploy enforcement detail.
