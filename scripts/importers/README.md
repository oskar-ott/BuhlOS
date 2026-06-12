# Supabase importers (dry-run scaffolds)

Operator-run scripts that plan the Blob → Supabase Postgres import.
Contract and domain order: [docs/supabase-importer-plan.md](../../docs/supabase-importer-plan.md).
Environment rules: [docs/supabase-environment.md](../../docs/supabase-environment.md).

**Current state: dry-run only.** No script here can write to Supabase (no
client exists, planners are pure) or to Vercel Blob (only `readBlob` is
imported). `--write` must pass the env guard in write mode and even then
throws `WRITE_NOT_IMPLEMENTED`.

## structure-dry-run.js

Plans the structure slice: tenant, `user_profiles`, `jobs`, `job_members`,
`site_area_groups`, `site_areas`, `job_task_templates`, `tasks`.

```sh
# against live Blob (READ-ONLY; needs BLOB_READ_WRITE_TOKEN in the shell)
node scripts/importers/structure-dry-run.js

# against a local key-for-key snapshot (no tokens needed)
node scripts/importers/structure-dry-run.js --from-dir /path/to/snapshot

# machine-readable plan
node scripts/importers/structure-dry-run.js --from-dir snap --json
```

Snapshot directory mirrors blob keys exactly:
`<dir>/users.json`, `<dir>/jobs.json`, `<dir>/jobs/<jobId>/data.json`.

Output: per-table proposed insert counts, missing references (quarantined,
never guessed), duplicate legacy ids, invalid records (e.g. roles/statuses
that fail the schema CHECKs and need an explicit normalisation mapping),
warnings, and a summary. **Exit 0 = clean; exit 1 = hard validation errors.**

Never wired to API routes, deploys or cron. Tests:
`src/domains/importers/structure-import-plan.test.ts`.

## hours-dry-run.js

Plans the payroll-critical hours slice: `time_entries`, `time_entry_allocations`,
`payroll_runs` (and confirms `timesheet_approvals` stays empty — weekly closeout
is projection-only).

```sh
# against live Blob (READ-ONLY; needs BLOB_READ_WRITE_TOKEN)
node scripts/importers/hours-dry-run.js

# against a local snapshot (users/<id>/time-entries/<date>.json, payroll-runs.json)
node scripts/importers/hours-dry-run.js --from-dir /path/to/snapshot --json
```

Canonical source = `users/{userId}/time-entries/{date}.json` (one per user+day);
`jobs/{jobId}/hours.json` is legacy and **not** a source. Output: proposed
inserts + parity numbers (hours by user/week, by job/week, status splits,
allocation reconciliation) + 14 quarantine buckets (missing refs, duplicate
user+date, invalid dates/statuses/totals, ordinary+overtime≠total, over-16h,
allocation-sum≠total, non-Monday week-start, reopen/approval inconsistencies).
**Exit 0 = clean; exit 1 = hard validation errors.** Read-only by construction
(only `list`/`fetch`/`readBlob`); `--write` passes the env guard then throws
`WRITE_NOT_IMPLEMENTED`. Tests: `src/domains/importers/hours-import-plan.test.ts`.
Findings: [docs/supabase-hours-dry-run-report.md](../../docs/supabase-hours-dry-run-report.md).
