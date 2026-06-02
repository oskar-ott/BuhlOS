# Test Data Rules

- Use the `SMOKE_TEST_` prefix for smoke jobs.
- Use the `STRESS_TEST_` prefix for load and stress data.
- Use the `QA_SEED_` prefix for stable, reusable seeded QA fixtures (e.g. `QA_SEED_Birdwood_Field_Test`).
- Never use real client names for generated tests.
- After any smoke run, verify nothing is left Active: `npm run qa:list-smoke-jobs` (read-only; exits non-zero if any test job is Active). See `docs/testing/Seeded-Authenticated-QA.md`.
- If a test publishes a job, unpublish it before finishing.
- If no delete endpoint exists, park the job as Draft.
- Do not mutate production data destructively.
- Assume a preview may share the production Blob store until proven otherwise.
- Warn explicitly in every report when preview and production share storage.
- Never commit, print, screenshot, or paste credentials.
