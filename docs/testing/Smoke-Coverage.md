# Smoke Coverage Matrix

What each Playwright smoke spec under `tests/playwright/smoke/` actually proves,
where it runs, and what it does **not** cover — so new coverage is added
deliberately instead of by guesswork.

Read alongside:

- [Field-Readiness-Smoke.md](./Field-Readiness-Smoke.md) — the deepest spec.
- [Seeded-Authenticated-QA.md](./Seeded-Authenticated-QA.md) — the QA fixtures + accounts.
- [Known-Risk-Areas.md](./Known-Risk-Areas.md) — broader risk register.

## The three coverage layers

Most of the BuhlOS/Phil contract is proven **below** the browser smoke, in
normal CI. The smoke layer only exists for the few things that need a real
browser against a real deployment.

| Layer | Runs in | Needs browser? | Needs secrets? | Touches data? | Proves |
| --- | --- | --- | --- | --- | --- |
| **Unit** (`npm run test:unit`, `src/**/*.test.ts`) | every PR + push (CI `check`) | no | no | no (mocked Blob) | pure logic + contracts — e.g. `src/middleware.test.ts` (full redirect/landing/role gate), `src/domains/qa/time-entry-attribution.test.ts` (the #77 attribution rule), `src/components/phil/PhilTabBar.render.test.tsx` (the global Capture FAB entry + bottom-nav contract), API handlers against an in-memory Blob |
| **Smoke discovery** (`npm run check:smoke-list` = `playwright test tests/playwright/smoke --list`) | every PR + push (CI `check`) | no | no | no | every smoke spec + its imports **compile & are discoverable** (no browser, server, network, or data) |
| **Preview Smoke** (`npm run test:smoke`) | `preview-smoke.yml`, **manual `workflow_dispatch` only** | yes (chromium) | yes (4 `BUHLOS_TEST_*`) | reads live preview; one spec writes (see below) | the live BuhlOS → Phil browser flow against a guarded Vercel preview |

Separation guardrails (verified):

- Normal CI never launches a browser or runs a live smoke — only `--list`.
- `preview-smoke.yml` is `workflow_dispatch`-only and runs
  `scripts/qa/validate-preview-url.js` **before** `npm ci` / browser install, so
  a production or look-alike URL is rejected before anything executes.
- Admin **and** field credentials are both required, so Phil coverage can never
  silently skip in a credentialed run.

## Coverage matrix

Roles: **none** = unauthenticated · **admin** = `BUHLOS_TEST_ADMIN_*` · **field** = `BUHLOS_TEST_FIELD_*`.
"Mutates" = writes to the (possibly production-shared) preview Blob.

| Spec | Project | What it proves | Role | Mutates | Runs live in | Protects against |
| --- | --- | --- | --- | --- | --- | --- |
| `auth-routing.spec.ts` · unauth redirect | desktop-chrome | `/command-centre` while logged out → `/v2/login?next=…`, login form visible | none | no | Preview Smoke | auth gate not wired in the real deployment |
| `auth-routing.spec.ts` · admin shell | desktop-chrome | admin login → `buhlos-admin-shell` + nav render; `/v2/jobs` `h1`; **no** console errors / ≥500s; **no** legacy `.nav-pill` | admin | no | Preview Smoke | blank/legacy admin landing; runtime JS / 5xx on the landing |
| `auth-routing.spec.ts` · admin↔Phil + logout | desktop-chrome | admin bounced off `/phil/jobs` → `/command-centre`; logout → clean login; re-login | admin | no | Preview Smoke | cross-surface leak; broken logout/session |
| `phil.spec.ts` · shell + nav + lockout | mobile-phil | field login → `phil-shell`; `/phil/jobs` no Draft leak; Today/Jobs/Gear nav; `/v2/jobs/<id>/builder` → `/phil/my-day` | field | no | Preview Smoke | blank/legacy Phil shell; Draft leak to field; field reaching admin builder |
| `phil.spec.ts` · global Capture launcher | mobile-phil | field Capture FAB (`aria-label="Capture"`) opens the launcher `dialog`; honest picker / single-job chooser / empty state; Esc closes (read-only `GET /api/jobs` only) | field | no | Preview Smoke | the universal Capture entry point silently breaking |
| `phil.spec.ts` · open assigned job | mobile-phil | opens the exact seeded fixture job; `Capture evidence` CTA present **and** opens the capture sheet with this job's context; **no** Save/Publish | field | no | Preview Smoke | field job view losing read-only safety; the capture sheet not opening from the job |
| `field-readiness.spec.ts` · URL guard | desktop-chrome | smoke target host is never production | none | no | Preview Smoke (+ always) | a smoke pointed at prod |
| `field-readiness.spec.ts` · field sees only assigned active | desktop-chrome | clean `/phil/jobs`; opens assigned active fixture; read-only; locked out of builder | field | no | Preview Smoke | Draft/Archived leak; field write access |
| `field-readiness.spec.ts` · Standard Day attribution | desktop-chrome | the real `POST /api/time-entries` attributes hours to the exact assigned job, then the request is **aborted** | field | **no (aborts POST)** | Preview Smoke | the #77 `jobId:null` / wrong-job regression on the wire |
| `field-readiness.spec.ts` · office queue | desktop-chrome | admin reaches `/hours/approvals`; approver surface renders | admin | no | Preview Smoke | blank approvals surface |
| `job-builder.spec.ts` · lifecycle | desktop-chrome | admin create → structure → save (PUT) → reload persistence → Phil-preview derivation → publish → **park as Draft** | admin | **yes** (creates a `SMOKE_TEST_*` job; self-parks to Draft in `finally`) | Preview Smoke | broken admin job create/save/publish path |

### Shared helpers (`tests/playwright/helpers/`)

- `auth.ts` — `loginAsAdmin` / `loginAsField` assert the role landed on the
  expected surface with three distinct failure-mode messages (missing / bad /
  wrong-role creds); plus `logout`, `waitForSavedState`, `parkJobAsDraft`,
  `collectConsoleErrors`, `collectNetworkFailures`. Safe and reusable; no
  top-level side effects.
- `testData.ts` — credential getters (return `null` when unset → `test.skip`,
  so discovery and local runs need no secrets); `createSmokeJobName()` scopes
  the builder job to `TEST_RUN_ID`.
- `fieldReadiness.ts` — the field-readiness flow helpers; imports the pure
  attribution validator at `src/domains/qa/time-entry-attribution.ts`. No
  top-level side effects.

## Gaps & recommended next coverage (prioritised)

The redirect/landing contract, the attribution rule, and the modern admin/Phil
**landing** shells are already covered (unit + the smokes above), and the legacy
`/admin/operations` blank-shell class is guarded statically by
`scripts/smoke-admin-routes.js` + `check:production-shell` + `check:admin-shell`
in normal CI. The remaining gaps are therefore secondary, and each needs a
**credentialed Preview Smoke** run to validate — so they should be picked up
deliberately, not bolted on blind.

1. **Authenticated "renders, not blank" smoke for secondary surfaces.**
   Today only landing pages are proven to render. Admin inboxes
   (`/observations`, `/material-requests`, `/gear`, `/employees`) and Phil
   sub-pages (`/phil/jobs/<id>/itps`, `/phil/jobs/<id>/plans`, `/phil/gear`,
   `/phil/hours`) have no render check, yet blank-page regressions are the
   documented recurring failure class (`docs/regressions/admin-operations-blank.md`).
   *Shape:* one compact, data-driven check per role that loops a small route
   list and asserts the shell test-id + one stable heading — **no** brittle
   styling assertions. Credentialed (Preview Smoke); keep it shell-level to stay
   non-flaky.

2. **`job-builder.spec.ts` data hygiene.** It is the only smoke that writes to
   the Blob. It self-parks to Draft in `finally`, but there is no automated
   delete, so `SMOKE_TEST_*` drafts can accumulate on the preview store
   (`npm run qa:list-smoke-jobs` only lists). *Shape:* a tooling/Preview-Smoke
   cleanup that deletes only aged `SMOKE_TEST_*`-named drafts — never the seeded
   fixture or real jobs. Must not weaken the lifecycle assertions, which are the
   point of the test.

3. **Helper de-duplication.** `phil.spec.ts` re-implements the fixture-link +
   strict-mode logic that already lives in `fieldReadiness.ts`
   (`FIXTURE_JOB_NAME`, `fixtureJobLink`, `isStrict`, `openAssignedActiveJob`).
   Consolidating to the shared helpers removes drift. Low risk, but it changes a
   Preview-Smoke-only spec, so land it alongside a Preview Smoke dispatch to
   confirm behaviour is preserved.

> None of these are safe to add as a "tiny, locally-validatable" change: each
> needs a credentialed Preview Smoke run (or live-data tooling) to prove it
> works, which is out of scope for normal-CI-only validation. This doc exists so
> they can be scheduled deliberately when a Preview Smoke dispatch is planned.
