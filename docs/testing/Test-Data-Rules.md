# Test Data Rules

- Use the `SMOKE_TEST_` prefix for smoke jobs.
- Use the `STRESS_TEST_` prefix for load and stress data.
- Never use real client names for generated tests.
- If a test publishes a job, unpublish it before finishing.
- If no delete endpoint exists, park the job as Draft.
- Do not mutate production data destructively.
- Assume a preview may share the production Blob store until proven otherwise.
- Warn explicitly in every report when preview and production share storage.
- Never commit, print, screenshot, or paste credentials.
