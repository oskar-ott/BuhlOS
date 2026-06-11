# Test Data Rules

- Use the `SMOKE_TEST_` prefix for smoke jobs.
- Use the `STRESS_TEST_` prefix for load and stress data.
- Use the `QA_SEED_` prefix for stable, reusable seeded QA fixtures.
- Never use real client names for generated tests.
- **Active-status rules** (enforced by `npm run qa:list-smoke-jobs`):
  - Active `SMOKE_TEST_` jobs **fail** (must be parked to Draft).
  - Active `STRESS_TEST_` jobs **fail**.
  - Active `QA_SEED_` jobs **fail**, with exactly ONE exception:
  - **`QA_SEED_FIELD_ACTIVE_JOB`** — the only `QA_SEED_` job allowed to remain
    Active (the stable Phil field fixture, assigned to QA Field).
- After any smoke run, verify cleanliness: `npm run qa:list-smoke-jobs` (read-only;
  exits non-zero if any disallowed test job is Active). See `docs/testing/Seeded-Authenticated-QA.md`.
- If a test publishes a job, unpublish it before finishing — tests park, they
  never delete (delete-on-teardown would hide what the lister exists to catch).
- Parked test jobs are then deleted deliberately: `DELETE /api/jobs?id=<id>`
  (admin-only; refuses non-QA-prefixed names and anything not Draft/Archived), the
  `/v2/jobs` "Automated test data" cleanup card, or
  `npm run qa:purge-smoke-jobs` (dry run; `-- --apply` deletes after writing a
  `.qa-backups/` backup). Real jobs are never deletable through any of these.
- Do not mutate production data destructively.
- Assume a preview may share the production Blob store until proven otherwise.
- Warn explicitly in every report when preview and production share storage.
- Never commit, print, screenshot, or paste credentials.
