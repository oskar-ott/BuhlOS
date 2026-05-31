# Authenticated end-to-end smokes — guide

> Production-safe authenticated coverage for the BuhlOS + Phil loop. Every
> smoke here uses **real `/api/auth?action=login`** with operator-supplied
> credentials — there is **no auth bypass, no test-login route in production,
> and no faked cookies.** Local seed/fixture flows are documented separately.

## Why this exists

Unit + API integration tests (vitest) cover the domain logic with a mocked
Blob and signed sessions in-process. They do NOT prove the live HTTP wire is
correct against real Vercel functions + real Vercel Blob — which is where the
recurring "UI lets me in but the API 403s me" / "Blob read-after-write lag"
bugs live. The authenticated smokes close that gap by exercising the real
deployed chain end-to-end, with the operator's own session cookie.

## The smokes

| script | npm script | what it covers |
| --- | --- | --- |
| `scripts/auth-smoke-d55-snags.sh` | `smoke:auth-d55-snags` | Snags create + transition lifecycle (Phase D5) |
| `scripts/auth-smoke-e1-itp.sh` | `smoke:auth-e1-itp` | ITP attach / record / signoff (E1) |
| `scripts/auth-smoke-onboarding-o3.sh` | `smoke:auth-onboarding-o3` | Onboarding chain (admin add → invite → worker accept → single-use guard) |
| `scripts/auth-smoke-observations.sh` | `smoke:auth-observations` | **New (PR 5).** Observations field-to-office loop + PR 6's convert-to-snag (skipped if endpoint absent) |

## Shape

Every smoke follows the same shape:

1. **Prerequisites:** `curl` + `jq` on PATH; `BASE`, `ADMIN_USER`, `ADMIN_PASS`
   env vars set.
2. **Temp cookie jars** under `$TMPDIR` + a trap that removes them on exit.
   Cookies never leak to disk or stdout.
3. **DRY-RUN by default** (no writes): unauth gates 401, admin login 200,
   authed reads 200.
4. **WRITE mode** (`WRITE=1`): full mutate chain against a **preview** deploy.
   Mutations are tagged with a timestamp so leftovers are easy to find.
5. **Masked output:** tokens / ids are shortened on stdout; raw bodies are
   written to temp files and removed after use.
6. **Exit codes:** `0` all checks passed · `1` a check failed · `2`
   prerequisite missing.

## Running `smoke:auth-observations`

The new PR 5 smoke. Exercises:

- Unauth gates on `/api/observations` (cross-job, job-scoped, POST, PATCH).
- Admin login → cross-job inbox GET → job-scoped GET.
- *Optional* field-tier user → cross-job inbox 403.
- WRITE mode: create note → verify it lands in both views → triage chain
  (needs_action → in_review → resolved with note) → priority bump →
  404/400 negative cases.
- **PR 6 add-on:** create a `defect` observation → `POST /api/observations?
  action=convert-to-snag` → assert a real snag is created and the
  observation is linked + status flips to `converted`. The smoke prints a
  `PASS … endpoint not deployed yet (PR 6) — skipping` line if the
  endpoint isn't shipped on this deploy, so the same script works pre and
  post-PR 6.

### Dry run against production (safe)

```sh
BASE=https://buhlos.com \
ADMIN_USER=oskar ADMIN_PASS='…' \
npm run smoke:auth-observations
```

### Full chain against a preview (writes one row)

```sh
BASE=https://birdwood-git-<branch>-<hash>.vercel.app \
ADMIN_USER=oskar ADMIN_PASS='…' \
TEST_JOB_ID=birdwood-iv3232 \
WRITE=1 \
npm run smoke:auth-observations
```

Leaves behind: one observation row in `observations.json` (title
`qa smoke <ts>`, status=resolved at the end), and — once PR 6 is deployed —
one snag in `jobs/<TEST_JOB_ID>/data.json`. Manual Blob cleanup if you'd
rather not keep the test rows.

### Optional field-tier 403 check

```sh
FIELD_USER=qa-field FIELD_PASS='…' \
BASE=… ADMIN_USER=… ADMIN_PASS=… \
npm run smoke:auth-observations
```

If `FIELD_USER` is set, the smoke also logs in as that user and asserts they
get a `403` on the cross-job inbox API (admin-tier only, matching the BuhlOS
surface gate).

## How to set up QA credentials

The smokes use the **real onboarding flow** for credentials — no production
backdoor:

1. **QA admin:** create a one-off `qa.admin@…` user via the legacy add-user
   path or directly in `users.json` if you have Blob access. Mark with a
   `notes: "QA only"` tag so it's easy to recognise. Disable when not in
   use (the disabled-user gate then blocks login per PR #49).
2. **QA field worker:** issue an invite from `/employees` → admin add →
   resend / copy-link → accept the invite with a 4-digit PIN. This is the
   normal onboarding path; the smoke just consumes the resulting account.
3. **Rotate credentials** as you would any operator credential. Never paste
   them in chat or commit them.

## Local end-to-end is harder (and intentionally not faked)

`api/*.js` are Vercel serverless functions; `next dev` does NOT serve them.
A real local end-to-end therefore needs either `vercel dev` (with Vercel
project linking + Blob/SESSION_SECRET env) or a mock Blob layer. Both are
beyond the scope of PR 5 and easy to get subtly wrong (e.g. mock blob that
diverges from prod), so this guide deliberately points at preview-deploy
authenticated smokes as the canonical authenticated coverage.

The unit + API integration tests (`src/domains/**/*-api.test.ts`,
`src/lib/auth/legacy-*.test.ts`) already cover the API surface in-process
with the **real handler** + a mocked Blob, which is the right level of
"local authenticated" for the API. The browser end-to-end can be added
later via Playwright against a preview (the existing `tests/*.spec.ts` files
are the precedent), once browsers are installed in CI.
