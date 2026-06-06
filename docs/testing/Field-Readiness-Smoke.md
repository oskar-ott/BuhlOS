# Field-Readiness Smoke

A single **deterministic** Playwright smoke that proves the core BuhlOS → Phil
loop works end-to-end before controlled internal dogfood.

- Spec: [`tests/playwright/smoke/field-readiness.spec.ts`](../../tests/playwright/smoke/field-readiness.spec.ts)
- Helpers: [`tests/playwright/helpers/fieldReadiness.ts`](../../tests/playwright/helpers/fieldReadiness.ts)
- Runs as part of `npm run test:smoke` (the Preview Smoke workflow), default
  `desktop-chrome` project.
- Where this sits in the wider suite (and what is / isn't covered):
  [Smoke-Coverage.md](./Smoke-Coverage.md).

> **This supports controlled internal dogfood only.** A green run does **not**
> mean the app is ready for real field rollout. Real rollout still requires
> manual validation and the remaining hardening gates — see
> [docs/field-readiness/ROLL_OUT_STATUS.md](../field-readiness/ROLL_OUT_STATUS.md)
> and [docs/field-readiness/NEXT_HARDENING_LANE.md](../field-readiness/NEXT_HARDENING_LANE.md).

---

## 1. What this smoke proves

In a real browser, against a guarded preview (or local dev):

1. **Target safety** — the smoke target is a guarded preview/local URL, never production.
2. **Field sees only assigned active work** — QA Field reaches the Phil shell, `/phil/jobs` shows no Draft/Archived leak, and the seeded fixture `QA_SEED_FIELD_ACTIVE_JOB` is visible (in strict mode it MUST be).
3. **Field opens the job, read-only** — the opened job shows the field capture affordance and **no** admin Save/Publish controls.
4. **Field is locked out of admin** — a field role hitting `/v2/jobs/<id>/builder` is redirected to `/phil/my-day`.
5. **Hours attribution (#77)** — logging a Standard Day attaches the assigned job: the real `POST /api/time-entries` request carries a non-empty `allocations` array whose `jobId` is the **assigned job's id** (in strict mode the resolved fixture id, read from its `/phil/jobs/<id>` link), not merely *some* non-null value. The Standard Day button is enabled only when a job is attributed, so the UI can never submit `jobId:null` while an active assigned job exists.
6. **Office sees the queue with job context** — QA Admin reaches `/hours/approvals`; the approver surface renders (no blank shell). Per-entry job-context display (job name, or amber "No job assigned") is locked by the unit test `HoursApprovalsQueue.render.test.tsx`.

> **The POST-body attribution rule is unit-tested separately.** The exact-job
> check that item 5 asserts on the wire lives in a pure, framework-neutral helper
> (`src/domains/qa/time-entry-attribution.ts`) covered by
> `src/domains/qa/time-entry-attribution.test.ts` under `npm run test:unit`.
> Preview Smoke proves the live Phil UI *produces* the expected request; the unit
> tests protect the malformed / wrong-job / null-job request-body cases in normal
> CI, even when Preview Smoke does not run. This is request-shape coverage only —
> it does not change field-roll-out readiness (see
> `docs/field-readiness/ROLL_OUT_STATUS.md`).

> **The smoke specs are compile-checked in normal CI.** A no-browser Playwright
> discovery step — `npm run check:smoke-list` (`playwright test
> tests/playwright/smoke --list`), wired into the CI `check` job — lists every
> spec under `tests/playwright/smoke/`, compiling each one and its imports
> (including this spec's `fieldReadiness.ts` →
> `src/domains/qa/time-entry-attribution.ts` chain, plus the shared `auth.ts` /
> `testData.ts` helpers). So a broken spec or a broken helper import fails CI
> immediately, **without** launching a browser, starting a server, using
> secrets, or dispatching the credentialed Preview Smoke. It proves the suite
> *loads & is discoverable*, not that the flow *passes* — that remains Preview
> Smoke's job (§9).

## 2. What this smoke does NOT prove (deferred, on purpose)

- **Server-side persistence of the submitted hours.** The hours `POST` is asserted on the wire and then **aborted before it reaches the server**, so the smoke never writes a time entry to the (possibly production-shared) Blob. Server-side attribution acceptance/rejection is covered by the API unit tests added in #77 (`src/domains/time-entries/time-entry-attribution-api.test.ts`).
- **A specific freshly-submitted entry appearing in the admin queue.** Because nothing is persisted, the admin assertion is "surface renders + unit-locked job-context display", not "this run's entry shows job X". A fully-live variant is documented in §9.
- **Live job assignment mutation.** The smoke does not click "Save assignments". The assignment relationship is proven via the seeded fixture (QA Field sees `QA_SEED_FIELD_ACTIVE_JOB`); the assignment write is covered by `JobAssignmentPanel.render.test.tsx` + `src/domains/users` assignment tests.
- **Admin job create → publish → park lifecycle** — already covered by [`job-builder.spec.ts`](../../tests/playwright/smoke/job-builder.spec.ts).
- **Plans current/read-only + overlays.** No deterministic modern plan fixture exists yet (see [`tests/playwright/smoke/plans.pending.md`](../../tests/playwright/smoke/plans.pending.md)); plan live-smoke is deferred and intentionally **not faked**. Job-level read-only is partially covered (no admin controls on the opened Phil job).
- **My Gear / Needs Attention** — out of scope for this smoke.

## 3. Required secrets

Set as GitHub Actions secrets (see [Seeded-Authenticated-QA.md](./Seeded-Authenticated-QA.md)); values are never printed (names-only presence check):

```
BUHLOS_TEST_ADMIN_EMAIL      BUHLOS_TEST_ADMIN_PASSWORD     # QA Admin → /command-centre
BUHLOS_TEST_FIELD_EMAIL      BUHLOS_TEST_FIELD_PASSWORD     # QA Field → /phil/my-day
```

Both admin **and** field credentials are required by Preview Smoke. QA Field must be a **field-tier** account assigned to `QA_SEED_FIELD_ACTIVE_JOB`. Never commit, print, paste, or screenshot credentials.

## 4. Safe URL rules

- The canonical guard is [`scripts/qa/validate-preview-url.js`](../../scripts/qa/validate-preview-url.js), run by Preview Smoke **before** `npm ci`. It allows the exact Birdwood Vercel preview host (HTTPS only) and `localhost`/`127.0.0.1`; it rejects production (`buhlos.com`/`www`), empty, malformed, bad ports, and look-alike hosts.
- The spec adds an in-suite backstop test that refuses to run against a production host. It **never relaxes** the canonical guard.
- **Never** dispatch against production.

## 5. Test data naming

Follows [Test-Data-Rules.md](./Test-Data-Rules.md): `SMOKE_TEST_` (smoke), `STRESS_TEST_` (load), `QA_SEED_` (stable fixtures). The only `QA_SEED_` job allowed to remain **Active** is `QA_SEED_FIELD_ACTIVE_JOB` (the field fixture this smoke depends on). This smoke creates **no jobs**.

## 6. Cleanup rules

- This smoke is **non-mutating**: it creates no jobs and (by aborting the hours `POST`) writes **no time entries**. There is nothing to clean up.
- It does not publish or park any job. The stable fixture is left Active by design.
- After any smoke run, confirm cleanliness of the shared store with `npm run qa:list-smoke-jobs` (read-only; exits non-zero if any disallowed test job is Active except the fixture).

## 7. Known limitations

- **Preview/production may share Blob storage** ([Seeded-Authenticated-QA.md §9](./Seeded-Authenticated-QA.md)). This smoke is designed around that assumption — it asserts the hours request on the wire and aborts it, so it never writes to a shared store.
- **Phil runs on the desktop-chrome viewport here** (Phil is responsive). Mobile-viewport fidelity is owned by [`phil.spec.ts`](../../tests/playwright/smoke/phil.spec.ts) (mobile-phil project).
- **Backdate window scan**: the hours step selects an in-window date whose Standard Day button is enabled. If QA Field somehow has a logged entry on every in-window day, the step **throws with a clear message** (it does not silently skip).
- **Cold preview latency**: post-navigation assertions use generous timeouts; flakiness from a cold serverless start is reduced by `retries: 2` in CI (`playwright.config.ts`).
- **No silent skips in strict mode**: with `BUHLOS_SMOKE_STRICT=1` (set by Preview Smoke), credentials are required and the fixture must exist — a missing fixture is a failure, not a skip.

## 8. Manual dogfood checklist

This automated smoke complements, but does not replace, the supervised manual
dogfood walkthrough. Use
[docs/field-readiness/DOGFOOD_CHECKLIST.md](../field-readiness/DOGFOOD_CHECKLIST.md)
for the full before → admin setup → field worker → office review → cleanup →
stop-conditions flow.

## 9. How to dispatch safely

Authenticated Phil pages can't run on local `next dev`, so the credentialed
smoke runs against a Vercel **preview** via the guarded workflow:

```bash
# From a branch with a healthy Vercel preview deployment:
gh workflow run preview-smoke.yml \
  --ref <branch> \
  -f preview_url=https://birdwood-<preview-slug>-oskars-projects-86c0cb7e.vercel.app
```

Order of signal in the run log: secret-presence (names only) → validate inputs
(admin + field required) → preview-URL guard (rejects production) → Playwright.
**Never** pass a production URL. **Do not** run against production.

**Optional fully-live variant (writes QA data — run deliberately).** To also
prove server-side persistence and that the office sees the exact submitted
entry, a tester can, on a preview, sign in as QA Field and submit a Standard Day
for `QA_SEED_FIELD_ACTIVE_JOB`, then sign in as QA Admin and confirm the entry
shows the job name in `/hours/approvals`. This **writes a QA time entry to the
(possibly shared) Blob** and has no delete endpoint, so it is a deliberate
manual step, not part of the automated smoke.

## 10. How to inspect failures

- The workflow uploads the Playwright **HTML report** and, on failure, **traces,
  screenshots, and videos** (`test-results/`) as run artifacts.
- A `"login REJECTED / wrong role"` message is a **credential/account** problem
  (point `BUHLOS_TEST_*` at the dedicated QA accounts), not an app bug.
- A `"requires the exact seeded fixture QA_SEED_FIELD_ACTIVE_JOB"` failure means
  QA Field isn't assigned to the active fixture — fix the seed
  ([Seeded-Authenticated-QA.md](./Seeded-Authenticated-QA.md)), don't relax the test.
- An attribution failure (`must attach a non-null jobId`, or `must attribute to
  the assigned job`) is a **real #77 regression** — stop and report; do not
  weaken the assertion.

---

Cross-refs: [Seeded-Authenticated-QA.md](./Seeded-Authenticated-QA.md) ·
[Test-Data-Rules.md](./Test-Data-Rules.md) ·
[Claude-Authed-Preview-Smoke.md](./Claude-Authed-Preview-Smoke.md) ·
[`.github/workflows/preview-smoke.yml`](../../.github/workflows/preview-smoke.yml) ·
[docs/field-readiness/ROLL_OUT_STATUS.md](../field-readiness/ROLL_OUT_STATUS.md).
