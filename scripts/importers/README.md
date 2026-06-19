# Supabase importers

Operator-run scripts for the Blob → Supabase Postgres import.
Contract and domain order: [docs/supabase-importer-plan.md](../../docs/supabase-importer-plan.md).
Environment rules: [docs/supabase-environment.md](../../docs/supabase-environment.md).

**State:** the dry-run planners are pure; `hours-parity.js` *reads* Postgres to
compare against Blob; **`structure-import.js` is the first real writer** (the
FK-root slice — tenant/users/jobs — guarded, idempotent, transactional). Every
script is dev-targeted by default and never wired to a route/deploy/cron.
Writes only ever happen behind `getDb({ mode: 'write' })` and the env guard, so
the production project is only reachable with the explicit
`SUPABASE_ALLOW_PRODUCTION_WRITES` opt-in. The old `*-dry-run.js --write` path
remains a planner-only scaffold that throws `WRITE_NOT_IMPLEMENTED`.

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

## structure-import.js

The first real **writer** — the FK-root slice the hours importer depends on:
`tenants` (one, minted by `slug`) → `user_profiles` → `jobs`.

```sh
# dry-run (no writes): proposed vs current counts. needs the dev SUPABASE_* env
node scripts/importers/structure-import.js
# apply to the target (dev), in one transaction
node scripts/importers/structure-import.js --write
node scripts/importers/structure-import.js --write --json
```

Idempotent upserts on the legacy unique keys (`tenants.slug`,
`user_profiles(tenant_id,legacy_user_id)`, `jobs(tenant_id,legacy_id)`), each
`DO UPDATE` guarded by `IS DISTINCT FROM` so an unchanged re-run writes nothing
(0 inserted, 0 updated — no `revision`/`updated_at` churn). tenant+users+jobs
commit in **one transaction**. An unknown role/status or duplicate legacy id
**quarantines the record and aborts before any write** (exit 1) — never guessed.
Field mapping verified against the live blob (`type`→`job_type_label`,
`serviceM8JobId`→`external_ref`, …). A transient Supavisor `CONNECTION_CLOSED`
can occur on connect — the import is transactional (no partial writes) and
idempotent, so just re-run. **Deferred to their own slices:**
`site_area_groups`/`site_areas`/`job_members`; `tasks` (must bind to the
canonical task index, never minted blind); `jobs.client_user_id`/`created_by`/
`modules` (cross-table/jsonb). Pure row builder: `lib/structure-rows.js`. Tests:
`src/domains/importers/structure-rows.test.ts`.

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

## hours-import.js

Writes `public.time_entries` from the Blob day-files — the slice that flips
`hours-parity.js` to **IN SYNC**. Run **after** `structure-import.js` (it
resolves each blob user id to its minted `user_profiles` uuid).

```sh
node scripts/importers/hours-import.js            # dry-run (proposed vs current)
node scripts/importers/hours-import.js --write     # apply to the target (dev)
node scripts/importers/hours-import.js --json
```

Same posture as `structure-import.js`: guarded (`getDb({mode:'write'})` → env
guard; prod needs the explicit opt-in), one transaction, idempotent upsert on
`(tenant_id, user_id, work_date) WHERE deleted_at is null` with an
`IS DISTINCT FROM` guard (unchanged re-run writes nothing). Validators reused
from the dry-run planner — a missing user ref, bad date, non-positive/over-16h
total, ordinary+overtime≠total, unknown status, or over-length notes
**quarantines the entry and aborts before any write**. **Deferred to own
slices:** `time_entry_allocations` (no per-row legacy key) and `payroll_runs`;
the `approved_by`/`created_by` attribution columns (left NULL). Pure row
builder: `lib/hours-rows.js`. Tests: `src/domains/importers/hours-rows.test.ts`.

## allocations-import.js

Writes `public.time_entry_allocations` — the per-job hours breakdown of each
entry (`jobId null` = "Internal — no job"). Run **after** `hours-import.js`
(allocations are children of `time_entries`, resolved from `(user, work_date)`).

```sh
node scripts/importers/allocations-import.js            # dry-run
node scripts/importers/allocations-import.js --write     # apply to the target
```

Allocations have **no per-row legacy key**, so they can't be upserted row-by-row.
Instead they're reconciled **per parent entry**: a stable `canonicaliseAllocations`
string is compared between the proposed (blob) and stored (Postgres) sets, and an
entry's allocations are replaced **only when they differ** — an unchanged re-run
writes nothing. Guarded + one transaction like the other writers; a missing
user/time_entry/job ref, hours ≤ 0, allocation-sum ≠ entry total, or over-length
notes **quarantines and aborts before any write**. Pure builder:
`lib/allocation-rows.js`. Tests: `src/domains/importers/allocation-rows.test.ts`.

## hours-parity.js

The **read-only hours proving slice** and the dual-write's future drift alarm
(roadmap [Phase 1 → Phase 2](../../docs/architecture/supabase-migration-roadmap.md),
P7). Reads the live Blob source of truth **and** the Postgres mirror, then
reports the drift between them.

```sh
# point at DEV; needs the dev SUPABASE_* env + BLOB_READ_WRITE_TOKEN
node scripts/importers/hours-parity.js
node scripts/importers/hours-parity.js --json
```

Matches the two stores on the business key `(legacy user id, work_date)` —
Postgres rows are resolved back to the legacy user id via
`user_profiles.legacy_user_id`, since Blob keys on the legacy id and Postgres on a
minted uuid. Reports four drift classes: only-in-Blob (mirror behind),
only-in-Postgres (orphan / deleted in Blob), value mismatches (hours/status
disagree, within the schema's `0.011` tolerance), and duplicate keys. Output
ends `IN SYNC` or `DRIFT DETECTED` with a signed `drift hours` total (positive =
Postgres behind). **Read-only:** Postgres via `getDb({ mode: 'read' })` (env
guard first), Blob via `list`/`fetch` only; never wired to a route/cron.
Against today's empty dev Postgres it honestly reports the full backlog as
drift. Engine: `lib/hours-drift.js` (pure). Tests:
`src/domains/importers/hours-drift.test.ts`.
