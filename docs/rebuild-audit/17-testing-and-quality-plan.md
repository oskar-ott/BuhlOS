# 17 · Testing and quality plan

> The quality gates that every phase of the rebuild must pass. The legacy repo had zero tests; this document establishes the minimum bar from Phase A onward and the additional bar each subsequent phase must clear.

---

## A. Minimum scripts (Phase A baseline)

These scripts exist from Phase A and must keep passing on every subsequent PR:

| Script | Tool | Purpose | Phase added |
| --- | --- | --- | --- |
| `npm run typecheck` | `tsc --noEmit` | Strict TypeScript across `src/` + `tests/` | A |
| `npm run lint` | `next lint` (ESLint) | next/core-web-vitals + next/typescript + no-alert, no-inline-style, no-deprecated-naming | A |
| `npm run test` | Vitest | Unit tests for `src/**/*.test.ts` | A |
| `npm run test:e2e` | Playwright | Route smoke + auth gate + feature flows | A (spec) + run in B onward |
| `npm run build` | `next build` | Production build, catches type errors in App Router contracts | A |
| `npm run check:admin-shell` | node | Legacy guard: every admin page wires `SHELL.boot()` | pre-existing |
| `npm run check:sw-cache-version` | node | Legacy guard: `CACHE_VERSION` bumped if shell files changed | pre-existing |
| `npm run check:production-shell` | node | Legacy guard: production HTML contains BuhlOS Command Centre, no legacy markers | pre-existing |
| `npm run smoke:admin-routes` | node | Legacy guard: 18-assertion smoke over `/admin/operations` | pre-existing |
| `npm run check:prod-branch` | node | Legacy guard: blocks deploy from non-`main` branch (kept until Phase B Vercel lock) | pre-existing |
| `npm run format:check` | Prettier | Format consistency | A |

---

## B. Per-test-kind gates

### B.1 Typecheck

- **Zero errors.** PRs cannot merge with a typecheck error.
- **No `any`.** `tsconfig.json` strict + `noImplicitAny`; `any` is forbidden by convention (no lint rule yet, but reviewed in code review).
- **No `as` casts** without a comment explaining why and when they go away. (Phase A has 2 casts in `redirect(... as Route)`; both documented.)

### B.2 Lint

- **Zero warnings or errors.** PRs cannot merge with a lint warning.
- **Custom rules** (`.eslintrc.json`):
  - `no-alert` — ban `alert()` / `confirm()` / `prompt()`.
  - `no-restricted-syntax` selectors:
    - Inline `style=` JSX attributes.
    - Literal strings matching `/site[-_ ]?office/i`.
    - `CallExpression[callee.name='alert' | 'confirm' | 'prompt']`.
- **Exempted folders:** `public/`, `api/`, `scripts/`, `migrate-*.js`, `recover-*.js`, `seed-*.js`, `unify-*.js`, `playwright-report/`, `test-results/`, `.next/`.

### B.3 Unit tests (Vitest)

- **Coverage targets** (informational, not gated by Phase A):
  - Phase A: `src/lib/auth/*` — 100% coverage of `landingFor()` + `rolePermits()` + `canAccessSurface()`.
  - Phase B: `src/domains/timesheets/*` — every pure helper covered.
  - Phase C+: every new domain ships with its own `<domain>.test.ts`.
- **Gates:** all tests pass; no skipped tests on `main`.

### B.4 Integration tests (Vitest)

- **Scope (Phase B+):** API client + Zod schema parsing.
  - Mock fetch; assert client passes a happy response to a parsed object.
  - Assert client returns `{ ok: false }` for malformed responses (no throw).
- **Where:** `src/domains/<domain>/<domain>.integration.test.ts`.

### B.5 Playwright route smoke tests

- **Phase A spec** (`tests/phase-a.spec.ts`) — 4 cases:
  1. Unauthenticated `/v2/phil` → redirects to `/v2/login`.
  2. `/v2/login` renders the sign-in form.
  3. Unauthenticated `/command-centre` → redirects to `/v2/login`.
  4. Demo-mode banner visible on `/v2/login`.
- **Phase B additions:**
  - Tradie login flow → /phil/my-day → submit Standard Day → assertion entry appears in admin queue.
  - Admin login flow → /hours/approvals → approve → assertion entry status flips.
- **Phase C+:** one route smoke per new section + one E2E per new feature.
- **Phase B hours E2E is the reference loop** — it must always pass on `main` and on every PR.

### B.6 Auth redirect tests

- **Phase A** (vitest): `landingFor()` returns expected URLs for every role category + unknown role.
- **Phase B** (playwright): tradie login lands on /phil/my-day; admin login lands on /command-centre; LH lands on /lh.

### B.7 No-legacy-name tests

- **Phase A** (lint): ESLint rule rejects `/site[-_ ]?office/i` literals.
- **Phase B+** (vitest):
  - `src/lib/storage/migrate-local-storage.ts` test that the boot migration deletes legacy keys.
- **Phase C+** (playwright):
  - After login, page DOM does not contain "Site Office" or "site-office" strings (case-insensitive).

### B.8 No-direct-production-deploy guard

- **Phase A:** `deploy:prod` removed from `package.json`.
- **Phase B:** `check:prod-branch` retained as defence-in-depth.
- **Phase B:** Vercel project settings locked so only `main` auto-deploys to production.
- **Phase B:** `GUARD_OVERRIDE` env support removed from `scripts/check-prod-branch.js`.
- **Phase F+:** the entire script can be deleted once Vercel lock is verified for 6 months.

### B.9 Mock data banner tests

- **Phase A:** Playwright asserts `DemoModeBanner` is visible on `/v2/login` (where `fixtures.isDemoMode()` is true).
- **Phase B+:** test asserts banner *disappears* on a route once the per-domain `fixtures.isDemoMode()` returns false.
- **Phase B+:** test asserts banner *appears* on `/hours/approvals` if fixtures are forced on for testing.

### B.10 UNDER CONSTRUCTION visibility tests

- **Phase A:** Playwright asserts UC entries in `AdminSidebar` are rendered with the "UC" pill and are non-interactive.
- **Phase A:** Playwright asserts UC tabs in `PhilTabBar` are rendered with the dot indicator and are non-interactive.
- **Phase B+:** each UC entry retired must have its test updated to remove the UC assertion and add a live-route assertion.

### B.11 Route collision tests

- **Phase B add:** `scripts/check-route-collisions.js`:
  - Parse `vercel.json` rewrites → list of claimed source paths.
  - Walk `src/app/**/page.tsx` → list of Next.js routes.
  - Fail if any Next.js route appears in claimed rewrites without an accompanying rewrite removal.
- **Run:** as part of `npm run lint` or as a standalone CI step.

### B.12 API contract tests

- **Phase B add:** for every endpoint a new domain calls, vitest test:
  - Mock the endpoint response.
  - Assert the Zod schema parses it.
  - Assert the typed client returns the expected shape.
- Catches drift between client expectations and server reality.
- For legacy endpoints consumed verbatim, the test asserts the schema we *think* exists matches the real response (one-time verification per endpoint).

### B.13 Deployment preview checklist (Phase A onward)

For every PR with a Vercel preview:

- [ ] Preview URL opens to the page the PR changes.
- [ ] Phase A baseline: typecheck + lint + test + build all green in CI.
- [ ] Legacy guards (4) all green.
- [ ] Playwright spec for the changed phase passes against the preview.
- [ ] No "Site Office" or "Switchboard" (as product label) visible in DOM.
- [ ] `DemoModeBanner` visible where it should be.
- [ ] Cross-route navigation: clicking each nav item lands on the right page (or shows UC).
- [ ] On-call ack if the PR is touching production routing.

---

## C. Per-phase acceptance criteria

### C.1 Phase A — App shell foundation

**Must pass:**

- `npm install` succeeds.
- `npm run typecheck` → zero errors.
- `npm run lint` → zero warnings.
- `npm run test` → all vitest pass (Phase A has `landing.test.ts` with 7 tests).
- `npm run build` → succeeds.
- All four legacy guards pass: `check:admin-shell`, `check:sw-cache-version`, `check:production-shell`, `smoke:admin-routes`.
- Routes render in `npm run dev`:
  - `/v2/login` → new sign-in form.
  - `/command-centre` → unauth redirects to `/v2/login`.
  - `/v2/phil` → unauth redirects to `/v2/login`.
  - `/admin/operations` → legacy SPA unchanged.
  - `/my-day` → legacy tradie home unchanged.

**Must not regress:**

- Any existing `public/*.html` file (don't touch any).
- `vercel.json` (don't edit).
- Any `api/*.js` endpoint (don't edit).
- Existing PWA install or service worker (don't touch).
- Any `scripts/*.js` (don't edit).

**Manual checks:**

- Open `/v2/login` in browser; verify form composition, brand tokens applied.
- Open `/command-centre` while logged in as admin; verify sidebar + topbar render.
- Open `/v2/phil` while logged in as tradie; verify Phil shell.

**Automated checks:**

- CI workflows `.github/workflows/pr.yml` and `.github/workflows/main.yml` enforce the above on PR + main.

**Production cutover allowed?**

- **No.** Phase A scaffold deploys to Vercel previews; it does NOT flip any rewrite or take over any legacy URL.

### C.2 Phase B — Hours loop

**Must pass:**

- All Phase A criteria.
- New Vitest: `src/domains/timesheets/timesheets.test.ts` covers happy path + error cases for the typed client.
- New Playwright:
  - Tradie login → `/phil/my-day` → tap Standard Day → entry visible in their own list.
  - Admin login → `/hours/approvals` → entry visible → approve → status flips to approved.
  - Reject flow with reason.
- Existing `/api/time-entries*` endpoints unchanged (verified by integration tests).
- CSV export downloadable from `/hours/approvals`.

**Must not regress:**

- Phase A surfaces.
- Existing `/api/time-entries*` shape (legacy Phil still calls these).
- Legacy `/my-day`, `/phil-hours` unchanged (they keep working until Phase C cutover).

**Manual checks:**

- Tradie installs new Phil shell, submits Standard Day from sunlight + gloves.
- Admin approves week of entries, exports CSV.
- Pay clerk imports CSV into payroll system without manual fix-up.

**Automated checks:**

- Phase B Playwright spec passes against preview URL.
- Standard Day submission completes in < 15 seconds (Playwright timing assertion).

**Production cutover allowed?**

- **No production route flip in Phase B.** Phase B is shipped on parallel routes (`/phil/my-day`, `/hours/approvals`) while legacy continues. Cutover of `/login` + `/phil` + `/my-day` happens at *start* of Phase C, gated on one week of clean Phase B usage.

### C.3 Phase C — Gear loop

**Must pass:**

- All Phase B criteria.
- New Vitest: `src/domains/gear/gear.test.ts`.
- New Playwright:
  - Worker scans QR to check out asset → ownership transfers.
  - Worker scans to check in → ownership returns to depot.
  - Admin sees current holders in real time.
- `/phil` cutover: PWA `start_url` updated, SW cache bumped, legacy `/my-day` quarantined to `/legacy/my-day`.

**Must not regress:**

- Hours loop must continue to work *during and after* the Phil cutover.
- Existing PWA installs receive update and continue functioning.

**Manual checks:**

- Tradie with installed PWA opens app post-deploy; launches to `/phil/my-day`.
- Tradie checks out a drill; admin sees it in real time on `/gear`.

**Automated checks:**

- Phase B + Phase C Playwright specs both pass.
- SW cache version assertion fires if `_shell.js` changes.

**Production cutover allowed?**

- **Yes, in scope:** `/login`, `/phil`, `/my-day`, `/phil-hours`, `/my-gear` cutover at start of Phase C. Each is its own PR with its own rollback plan.

### C.4 Phase D — Jobs & evidence

**Must pass:**

- All Phase C criteria.
- New Vitest: `src/domains/{jobs,evidence,snags}/*.test.ts`.
- New Playwright:
  - Worker captures photo on a task → admin sees in job timeline.
  - Worker raises snag with photo → admin triages → admin closes.
  - PM opens job page → sees stages, areas, tasks, photos, snags, hours roll-up.
- Patch endpoints for jobs (replacing full-doc writes) shipping with Zod validation.

**Production cutover allowed?**

- **Yes, in scope:** `/admin` and `/admin/*` section-by-section as each lands. `/jobs`, `/jobs/:jobId`, `/snags`, `/activity` cutover.

### C.5 Phase E — ITP / RFI / materials / plans / variations

**Must pass:**

- All Phase D criteria.
- New Vitest + Playwright per domain.
- Four-eyes ITP sign-off enforced (different licensed user reviews than submitter).
- Plan acknowledgement blocking modal verified.

**Production cutover allowed?**

- **Yes:** remaining `/admin/*` sections cutover as they land.

### C.6 Phase F — Reporting / integrations / intelligence

**Must pass:**

- All Phase E criteria.
- AuditLog unified across all domains.
- Reports render real aggregations.
- Xero CSV export validated against payroll system.
- AI plan interpretation rebuild verified.

**Production cutover allowed?**

- **Yes:** any remaining legacy admin pages, `/support`, `/reports`, `/settings/integrations`.

### C.7 Phase G — SW rewrite + legacy quarantine

**Must pass:**

- Service worker is push-notifications-only (no shell cache).
- All `public/*.html` moved to `public/_legacy/`.
- `/legacy/*` rewrite added; old `vercel.json` rewrites deleted.
- `/buhlos/*`, `/admin-legacy`, `/dev/*` rewrites deleted entirely.

**Production cutover allowed?**

- **Yes:** legacy is gone.

---

## D. CI / pipeline gates

### `.github/workflows/pr.yml`

Runs on every PR to `main`:

```yaml
jobs:
  ci:
    runs-on: ubuntu-latest
    env:
      SESSION_SECRET: ci-placeholder-session-secret-long-enough
    steps:
      - checkout
      - setup-node@v4 (node 24)
      - npm install
      - npm run typecheck
      - npm run lint
      - npm run test
      - npm run build
      - legacy guards (4)
```

### `.github/workflows/main.yml`

Runs on push to `main`:

- Same as `pr.yml`.
- Vercel auto-deploys on green.

### Vercel project settings

- **Production branch:** `main` only.
- **Auto-deploy:** on push to `main`.
- **Preview deploys:** on every PR.
- **Manual production deploys:** disabled for non-owner accounts.

---

## E. Phase exit checklist (use before declaring a phase done)

For every phase:

- [ ] All new tests passing on PR + on main.
- [ ] All legacy guards passing.
- [ ] Manual smoke completed (per phase, listed above).
- [ ] Playwright reference suite (hours loop) still green.
- [ ] No new ESLint warnings.
- [ ] No new `any` casts or `@ts-ignore`.
- [ ] No deprecated naming in new code (lint enforces).
- [ ] DemoModeBanner accurately reflects mock vs live per domain.
- [ ] Docs updated: phase brief marked complete; relevant audit doc reflects new state.
- [ ] One-week quiet period in preview (or production for in-scope cutovers).
- [ ] Sign-off recorded: who reviewed, when.

---

## Cross-references

- [16-migration-strategy.md](16-migration-strategy.md) — phase ordering + cutover preconditions referenced here.
- [18-phase-a-implementation-brief.md](18-phase-a-implementation-brief.md) — Phase A exit criteria detail.
- [19-phase-b-hours-implementation-brief.md](19-phase-b-hours-implementation-brief.md) — Phase B exit criteria detail.
- [20-agent-rules.md](20-agent-rules.md) — rules agents must follow during testing.
- [06-deployment-audit.md](06-deployment-audit.md) — Phase 1A deploy enforcement.
