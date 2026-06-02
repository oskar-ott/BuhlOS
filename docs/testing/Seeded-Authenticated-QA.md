# Seeded Authenticated QA

How to run BuhlOS/Phil authenticated preview smoke against **dedicated test
accounts** instead of personal or production-style logins, and how to keep the
test data clean.

> **Verification-first (by design).** The app stores users in `users.json` in
> Vercel Blob and creates them only through the admin-gated `api/users.js`
> (bcrypt password + `writeBlob`). There is **no safe automated seed path** that
> tooling can run without (a) an admin session/credential and (b) writing to a
> Blob store that is shared with production. So this harness does **not**
> auto-create accounts. It documents manual account setup and provides
> **read-only** verification + detection helpers. Nothing here mutates prod data.

---

## 1. Required accounts

Create two **dedicated, disposable** accounts — never a personal or real-staff
login, and never the production admin:

| Account | Role | Purpose |
|---|---|---|
| **QA Admin** | an admin-tier role (`admin` / `office` / `pm` / …) | authenticated BuhlOS admin smoke → lands on `/command-centre` |
| **QA Field** | a field/LH role (`tradie` / `electrician` / `leadinghand` / …) | Phil field smoke → lands on `/phil/my-day` |

The QA Field account should be assigned to at least one **active** job so the
"open an assigned active job" spec exercises the read-only field view.

## 2. Creating the accounts (manual — no seed API is run by tooling)

Use the admin UI / `api/users.js` employee flow while signed in as a real
admin:

1. Sign in to the admin surface.
2. Create an employee for **QA Admin** with an admin-tier role and a password.
3. Create an employee for **QA Field** with a field/LH role + password, and
   assign it to a test/active job.
4. Confirm both can log in (step 4 below).

> If/when a dedicated seed endpoint or script is added, it must be idempotent,
> `SMOKE_TEST_`/`QA_SEED_`-scoped, and must not overwrite `users.json` wholesale.
> Until then, account creation is manual.

## 3. GitHub Actions secrets

Set these as **repository Actions secrets** (Settings → Secrets and variables →
Actions). The Preview Smoke workflow injects them as env; values are never
printed (the workflow's "Report configured QA secrets" step prints only
present/MISSING by name).

```
BUHLOS_TEST_ADMIN_EMAIL
BUHLOS_TEST_ADMIN_PASSWORD
BUHLOS_TEST_FIELD_EMAIL
BUHLOS_TEST_FIELD_PASSWORD
```

`.env.test.example` holds **placeholders only** for local runs. Never commit
real values; never paste them into chat or PRs. Point them at the dedicated QA
accounts above.

## 4. Verifying credentials before a smoke run

The cheapest check is a manual login: open `<preview>/v2/login` and sign in with
each account.

- **QA Admin** must land on `/command-centre`.
- **QA Field** must land on `/phil/my-day`.

If login fails or lands elsewhere, the Playwright helpers now fail with an
explicit diagnostic that distinguishes the cause:

- **bad credentials** → "still on `/v2/login` after submit … (bad credentials)"
- **wrong role / surface** → "landed on `/x`, expected … (wrong role / wrong surface)"
- **missing secret** → "… credentials are not configured — set `BUHLOS_TEST_*`"

(See `tests/playwright/helpers/auth.ts`.)

## 5. Running Preview Smoke

Manually dispatch the **Preview Smoke** workflow (it's `workflow_dispatch`, so
secrets are allowed):

```
gh workflow run preview-smoke.yml \
  --ref <branch> \
  -f preview_url=<vercel-preview-url>
```

Order of signal in the run log: the **secret-presence report** (names only) →
**Validate smoke inputs** (hard-fails if the preview URL or admin creds are
missing; warns if field creds are absent) → Playwright. A Playwright failure
with a "REJECTED / wrong role" message is a **credential/account** problem, not
an app bug; a normal assertion failure is an app/test problem.

## 6. Listing SMOKE_TEST_ jobs (detect anything left Active)

```
BLOB_READ_WRITE_TOKEN=… npm run qa:list-smoke-jobs
```

Read-only. Lists every `SMOKE_TEST_` / `STRESS_TEST_` / `QA_SEED_` job with its
status and **exits non-zero (2) if any are ACTIVE**. The token comes from the
environment — the script never reads, prints, or stores it. (Prefixes are
locked by `src/domains/qa/smoke-jobs.test.ts`.)

## 7. Parking / cleaning test jobs

There is **no job delete endpoint**, so the rule is: **leave nothing Active.**

- The job-builder smoke parks its generated job back to **Draft** in a `finally`.
- If `qa:list-smoke-jobs` reports an Active test job, park it: open it in the
  admin builder and **unpublish to Draft** (Active → Draft). Re-run the lister
  to confirm `active=0`.
- Leftover **Draft** test jobs are acceptable; **Active** ones are not.

This repo does **not** ship a destructive auto-park script: parking is a `PUT`
that writes to the (possibly prod-shared) Blob, so it's done deliberately via
the admin UI rather than by unattended tooling.

## 8. What NOT to do

- Don't use personal or production logins as test accounts.
- Don't commit/print/paste credentials or `BLOB_READ_WRITE_TOKEN`.
- Don't leave any generated job **Active**.
- Don't use real client names in test jobs; prefix every test job with
  `SMOKE_TEST_` / `STRESS_TEST_` / `QA_SEED_` and describe it as automated QA data.
- Don't overwrite `users.json` / `jobs.json` wholesale.

## 9. If preview and production share Blob storage

Assume they **do** until proven otherwise (same `BLOB_READ_WRITE_TOKEN`). That
means a `SMOKE_TEST_` job created on the preview can appear in **production**
data. Therefore: keep the `SMOKE_TEST_`/`QA_SEED_` prefixes, never leave one
Active, run `qa:list-smoke-jobs` after a smoke run, and park/purge promptly. If
you confirm preview uses an isolated store, note it here and relax the warning.

---

Cross-refs: `docs/testing/Test-Data-Rules.md`, `docs/testing/Claude-Authed-Preview-Smoke.md`,
`.github/workflows/preview-smoke.yml`, `scripts/qa/list-smoke-jobs.js`,
`tests/playwright/helpers/auth.ts`.
