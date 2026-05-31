# BuhlOS and Phil App Test Plan

## 1. Purpose

This is the repeatable test contract for future PRs. Normal CI proves the
codebase is coherent. Preview smoke proves the deployed BuhlOS and Phil paths
still work against real auth, Vercel functions, and Blob storage. Humans merge
manually after reviewing both.

## 2. Testing principles

- Use the real login endpoint. Never add auth bypasses or commit credentials.
- Keep normal CI deterministic and secret-free.
- Run write smokes against previews, not production.
- Treat generated data as potentially shared with production Blob storage.
- Prefer DOM assertions and server-filter tests over screenshots alone.
- Leave every published smoke job parked as Draft.

## 3. Required commands

| Command              | Purpose                                               |
| -------------------- | ----------------------------------------------------- |
| `npm run typecheck`  | TypeScript                                            |
| `npm run lint`       | ESLint                                                |
| `npm run test:unit`  | Vitest unit and mocked-Blob handler integration tests |
| `npm run test:api`   | Focused mocked-Blob API suite                         |
| `npm run build`      | Next production build                                 |
| `npm run test:e2e`   | Full Playwright suite                                 |
| `npm run test:smoke` | Preview-oriented critical Playwright smoke suite      |
| `npm run check`      | Typecheck, lint, unit tests                           |
| `npm run check:full` | Check, build, full Playwright                         |

## 4. Required environment variables

Use `.env.test.example` as the placeholder-only reference:

```text
PLAYWRIGHT_BASE_URL
BUHLOS_TEST_ADMIN_EMAIL
BUHLOS_TEST_ADMIN_PASSWORD
BUHLOS_TEST_FIELD_EMAIL
BUHLOS_TEST_FIELD_PASSWORD
TEST_RUN_ID
```

Optional future LH smoke credentials:

```text
BUHLOS_TEST_LH_EMAIL
BUHLOS_TEST_LH_PASSWORD
```

## 5. Test data naming

Smoke jobs use `SMOKE_TEST_${TEST_RUN_ID}_Job_Builder`. Stress data uses a
`STRESS_TEST_` prefix. Never generate real client names.

## 6. Cleanup rules

Any test that publishes a job must unpublish it before finishing. The
Playwright builder flow uses a `finally` block to park its job as Draft. There
is no hard-delete cleanup requirement. If preview and production share one
Blob token, state that explicitly in the smoke report.

## 7. Auth and routing coverage

Automated smoke checks unauthenticated admin redirects, literal-admin login,
BuhlOS shell render, jobs-list access, admin redirect away from Phil,
field-to-Phil routing when credentials exist, field blocking from the admin
builder, and logout/login state.

## 8. Job builder coverage

The browser smoke creates a Draft, adds `Level 1`, `Unit 1`,
`Rough-in power circuits`, and `Fit-off power points`, saves, refreshes,
checks persistence, opens the saved-data Phil preview, verifies publish
errors vs warnings, publishes, unpublishes, and leaves the job as Draft.

## 9. Phil coverage

The mobile project checks the Phil shell, Today / Jobs / Gear navigation,
absence of Draft rows, builder blocking, and an assigned active job detail
when the QA field user has one. Server-level `/api/jobs` tests lock Draft and
Archived filtering even when field credentials are unavailable.

## 10. BuhlOS UI regression coverage

The admin smoke asserts shell and sidebar DOM markers, BuhlOS branding, the
jobs builder inside the admin shell, no `.nav-pill` legacy top layout, and no
obvious console errors or HTTP 5xx responses during shell load. Existing
legacy static guards remain in CI for `/admin/operations`.

## 11. Plans Phase 1/2 coverage

Current state: legacy `/admin/plans` upload/register and revision handling
exist; modern Phil has a read-only current-document list. The modern BuhlOS
register, PDF viewer, overlays, and field-visible overlay flow do not exist.
Do not add failing browser tests for unbuilt UI. The exact browser TODO is in
`tests/playwright/smoke/plans.pending.md`.

Existing unit coverage locks current / superseded / archived document
formatting and the Phil panel filters to current revisions. When the modern
viewer lands, add upload, immutable-source, revision, viewer, overlay,
visibility, and read-only browser tests.

## 12. Coordinate test coverage

No overlay coordinate library exists yet. When it lands, require unit tests
for 100% and 200% zoom centre, pan offsets, top-left, bottom-right, clamping,
normalised-to-screen round trips, mobile viewport, polyline points, and
rotation if supported. Coordinates must remain in `0..1`.

## 13. API test coverage

`src/domains/jobs/jobs-api.test.ts` calls the real `api/jobs.js` handler with
signed sessions and an in-memory Blob replacement. It covers Draft creation,
update, publish, unpublish, Draft and Archived field filtering, and blocked
field mutation. Existing colocated API tests cover auth, role tiers, audit
log, observations, and material requests. Add Plans handler tests when the
modern overlay contract exists.

## 14. Stress and load test plan

Stress tests are manual, preview/local only, and opt-in. Generate prefixed
data and record cleanup:

| Scenario        | Target                                                        |
| --------------- | ------------------------------------------------------------- |
| Jobs list       | 100 `STRESS_TEST_` jobs                                       |
| Builder         | 1,000 tasks and repeated saves                                |
| Plans register  | 100 drawings when modern register exists                      |
| Overlay viewer  | 1,000 markups when overlays exist                             |
| Save contention | Concurrent saves only on disposable preview data              |
| Viewer          | Large PDF render and pan/zoom timing when viewer exists       |
| Auth            | Repeated login and route reload                               |
| Dirty state     | Refresh during unsaved builder changes                        |
| Network         | Playwright throttling for cold-start and slow-response checks |

Never run expensive or destructive stress scenarios in default CI.

## 15. Merge blockers

Block merge for failed build, typecheck, lint on changed code, admin login
route breakage, blank BuhlOS shell, builder save failure, Draft field leakage,
publish/unpublish breakage, mock Phil preview, field access to builder,
committed credentials, failed Plans coordinate tests when Plans is touched,
or source PDF mutation when Plans is touched.

## 16. Warning-only issues

Warn without blocking for a cold-start retry that succeeds, intentionally
missing optional site address, field live-render smoke skipped because no QA
field credentials exist while code/API filters pass, and deferred overlay
smoke while the Plans overlay module is unbuilt.

## 17. Run locally

```bash
cp .env.test.example .env.test.local
# Fill local-only values, then export them into the shell if running Playwright.
npm ci
npm run check
npm run build
npx playwright install chromium
npm run test:smoke
```

`next dev` does not serve `api/*.js`; authenticated browser writes should
target a Vercel preview unless the local environment runs `vercel dev`.

## 18. Run preview smoke

In GitHub: **Actions** → **Preview Smoke** → **Run workflow** → paste the
Vercel preview URL. The workflow runs Playwright and uploads the HTML report
on every run plus traces, screenshots, and videos on failure. A dispatched
workflow may not have PR context, so inspect its Actions artifacts directly.

## 19. Claude handoff

Give Claude the preview URL, branch / PR, and credentials out-of-band. Claude
must read `docs/testing/Claude-Authed-Preview-Smoke.md`,
`docs/testing/Test-Data-Rules.md`, and `docs/testing/Known-Risk-Areas.md`,
run the live script, fix discovered bugs in the branch, add regression tests,
rerun checks, and report cleanup state before recommending a manual merge.
