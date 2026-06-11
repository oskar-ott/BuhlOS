# Supabase importer & parity plan

**Status:** plan only (2026-06-12). No importer writes exist; Blob remains the
sole production store. Prereqs already in place: Phase 1 schema + hardening
applied to `wetctlrhsycfwhuxlarv` (31 tables, RLS on, 0 policies, 0 rows),
migrations committed under [`supabase/migrations/`](../supabase/migrations/),
env-safety guard shipped ([`api/_lib/supabase-env.js`](../api/_lib/supabase-env.js),
[docs/supabase-environment.md](supabase-environment.md)). Strategy context:
[docs/supabase-migration-research-audit.md](supabase-migration-research-audit.md).

---

## A. Actual repo findings (inspected 2026-06-12)

### Modules inspected

| Module | Role |
|---|---|
| `api/_lib/blob.js` | central read/write: `readBlob` (list+fetch, 5s TTL cache, read-only), `writeBlob` (#157 guards: validation, shrink refusal, `__rev` stamping, stale-write 409), `deleteBlob` |
| `api/_lib/time-entries.js` | the entire hours storage layer (all 8 `time-entries*` endpoints consume it) |
| `api/_lib/job-tasks.js` | task override resolution + canonical progress counting |
| `api/_lib/job-duplicate.js` | canonical pure walk of job structure (groups → areas → per-stage tasks) |
| `api/_lib/audit-log.js` | cross-surface audit journal (monthly blobs, append-only, 5000-cap trim) |
| `api/users.js`, `api/_lib/auth.js` | users.json shape incl. `passwordHash` (bcryptjs) |
| `api/jobs.js`, `api/snags.js`, `api/evidence.js`, `api/photos.js` | jobs index + per-job `data.json` internals |
| `api/observations.js`, `api/material-requests.js`, `api/assets.js`, `api/job-itps.js`, `api/itp-templates.js`, `api/payroll-runs.js` | remaining Phase-1 domains |

### Blob paths discovered (the import surface)

| Blob path | Shape (verified in code) | Phase-1 tables it feeds |
|---|---|---|
| `users.json` | `{ users: [{ id, username, name?, email?, role, passwordHash, assignedJobIds[], hourlyRate?, xeroEmployeeId?, … }] }` | `user_profiles` (NO credential columns — `passwordHash` stays in Blob by design), `job_members` (from `assignedJobIds`) |
| `jobs.json` | `{ jobs: [{ id (slug, in URLs), name, status, type, modules, customFields, siteAddress/access/parking/contact/safety/induction…, ref, serviceM8JobId, clientUserId, roughInTasks[]/fitOffTasks[] (job-level defaults `{id,name,order,archived}`), areaGroups[]: { id (`ag_…`), name, order, archived, areas[]: { id (`ar_…`), name, spaceType, order, customFields, archived, roughInTasks?/fitOffTasks? (per-area overrides) } } }] }` | `jobs`, `site_area_groups`, `site_areas`, `job_task_templates` |
| `jobs/{jobId}/data.json` | `{ dwellings: { [areaId]: { roughIn: { tasks: { [taskId]: state } }, fitOff: {…} } }, snags: [legacy], snagsV2: [{ …, evidenceIds[] }], evidence: [], notes: [] }` — task state: complete = exactly `'complete'`, `in_progress` exists | `tasks`, `task_status_events` (current state only), `snags`, `evidence_files`, `evidence_links` |
| `users/{userId}/time-entries/{date}.json` | ONE entry per user per day: `{ id, date, totalHours (≤16), ordinaryHours, overtimeHours, startTime?, endTime?, breakMinutes?, notes?, status: draft\|submitted\|approved\|rejected, allocations[]: { jobId\|null ("Internal"), hours, … }, submittedAt?, approvedBy/At?, rejectedBy/At?, rejectedReason?, __rev }` | `time_entries`, `time_entry_allocations` |
| `users/{userId}/time-entries-audit/{yyyy-mm}.json` | append-only `[{ id, entryId, action, changedBy, note, diff, at }]` | `audit_logs` (hours slice) |
| `observations.json` | `{ observations: [...] }` (global store; `jobId: null` = office inbox; `linkedEvidenceId`) | `observations`, `evidence_links` |
| `material-requests.json` | `{ requests: [...] }` (global store; `linkedEvidenceId`) | `material_requests`, `material_request_items`, `evidence_links` |
| `assets/{id}.json` + `assets/{id}/history.json` | per-asset blob + `{ entries: [] }` transfer log; **no assets.json index — discovery is `list({prefix:'assets/'})`** | `assets`, `asset_assignments` |
| `jobs/{jobId}/itps.json` | `{ instances: [] }` (template snapshot at attach) | `itp_instances`, `itp_items`, `itp_responses` |
| `itp-templates.json` | `{ templates: [] }` | `itp_templates`, `itp_template_items` |
| `jobs/{jobId}/plans-index.json`, `…/documents-index.json` | doc/plan registers (binaries stay in Blob) | `documents` |
| `audit/{yyyy-mm}.json` | `{ entries: [{ id, ts, action, actorId, actorName, actorRole, jobId, targetType, targetId, summary, metadata }] }` — **trims at 5000/month (oldest 1000 dropped)** | `audit_logs` |
| `payroll-runs.json` | `{ runs: [] }` written by `/api/time-entries-export` | `payroll_runs` |

Also present but **not in the Phase-1 schema** (defer; do not invent tables):
`job-types.json`, `suppliers.json`, `wholesalers.json`, `quotes.json`,
`invites.json`, `employees.json`, `temps.json` + `temps/*`, `policy.json`,
`flags.json`, `activity.json`/`activity-archive.json`, `user-activity.json`,
`structure-presets.json` (**new in #363** — post-dates the schema),
per-job `tags.json`, `photos-index.json`, `ai-takeoff.json`,
`drawing-markups.json`, `materials-list.json`, `contacts.json`, `draft.json`,
`templates.json`, `snag-emails.json`, `audit.json` (legacy per-job log),
`hours.json` (legacy — `/api/hours` is deprecated; **NOT** an hours source).

### Differences from the prior research's assumptions

1. **No `assets.json` index** — assets are per-asset blobs discovered by
   prefix listing. The assets importer must `list()` rather than read one key.
2. **Evidence, snags and task state live inside `jobs/{id}/data.json`** —
   not separate per-domain stores. One read feeds four tables.
3. **`jobs/{id}/hours.json` exists but is legacy** (deprecated `/api/hours`);
   hours truth is only the per-user day blobs.
4. **Write guards landed (#157/#361)**: blobs now carry `__rev`; importer
   must strip `__rev`/guard metadata before shape validation and never
   round-trip it into Postgres columns.
5. **Audit monthly blobs trim at 5000 entries** — historical loss is
   possible and must be reported as a fact, not an importer error.
6. **`structure-presets.json` is brand new (#363)** and has no Phase-1
   table; record and skip.
7. **Task templates vs instances**: per-area override resolution is subtle —
   a non-empty `area.roughInTasks` wins, an *empty array means "use the job
   default"*, archived entries are excluded everywhere
   (`api/_lib/job-tasks.js` is the canonical rule and the importer must
   mirror it exactly or task counts will diverge from the app).

## B. Import order (FK-safe)

1. tenant seed (single row — the only non-Blob-sourced insert)
2. `user_profiles` ← users.json
3. `jobs` ← jobs.json
4. `job_members` ← users.json `assignedJobIds` (+ role=lead for LH-led jobs)
5. `site_area_groups` ← jobs.json areaGroups
6. `site_areas` ← areaGroups[].areas
7. `job_task_templates` ← job-level + per-area roughInTasks/fitOffTasks
8. `tasks` ← data.json dwellings state × effective template resolution
9. `task_status_events` / `task_comments` — current state only is derivable
   (legacy toggles overwrote history); import one synthetic event per
   completed task, flagged `metadata.importedCurrentStateOnly=true`
10. `evidence_files` ← data.json evidence (+ photo URLs stay Blob)
11. `evidence_links` ← snagsV2.evidenceIds[], observations.linkedEvidenceId,
    materialRequests.linkedEvidenceId
12. `snags` ← data.json snagsV2 (legacy `snags` array: report-only)
13. `observations` ← observations.json
14. `material_requests` ← material-requests.json
15. `material_request_items` ← request line items
16. `time_entries` ← per-user day blobs
17. `time_entry_allocations` ← entry.allocations[]
18. `payroll_runs` ← payroll-runs.json
19. ITP: `itp_templates` → `itp_template_items` → `itp_instances` →
    `itp_items` → `itp_responses`
20. `documents` ← plans-index + documents-index
21. `assets` ← assets/{id}.json (prefix listing)
22. `asset_assignments` ← per-asset history.json + currentHolder fields
23. `audit_logs` ← audit/{yyyy-mm}.json + per-user hours audit blobs

`timesheet_approvals` imports **nothing** (weekly closeout is a projection
today; table fills when closeout writes land — by schema design).
`outbox_events`, `snag_comments`, `task_comments` start empty (new
capabilities).

## C. Legacy ID strategy

- Every imported row sets `legacy_id` (or `legacy_export_id` /
  `legacy_template_id` where the schema names differ). The schema already
  enforces partial uniques `(tenant_id, legacy_id) WHERE legacy_id IS NOT
  NULL` on every imported table.
- **Idempotency = upsert keyed on the legacy unique**: re-running updates or
  skips deterministically, never duplicates. `time_entries` additionally has
  the natural key `(tenant_id, user_id, work_date) WHERE deleted_at IS NULL`
  — the importer treats user+date as the primary match and `legacy_id` as a
  consistency check.
- Mapping tables are built in-memory per run (legacy id → proposed/actual
  uuid) in strict dependency order; children resolve parents through the map.
- Old URLs keep working because legacy ids (job slugs, `ag_…`/`ar_…`,
  nanoid snag ids) are preserved verbatim.
- **Unresolved references are recorded in a failed-reference bucket and the
  row is quarantined — never silently nulled, never guessed.**

## D. Dry-run strategy

- **Dry-run is the default mode**; writes require a future explicit
  `--write` flag which must also pass
  `assertSupabaseAccess({ mode: "write" })` (the env guard).
- Dry-run reads Blob (read-only `readBlob`/`list`) or a local snapshot
  directory (`--from-dir`), validates source shapes, builds the full mapping
  + proposed-row sets, and **never touches Supabase** (no client, no
  connection).
- Output: per-table proposed insert/update counts, warnings, missing-ref
  bucket, duplicate legacy ids, invalid records, and a summary table; exit 0
  on a clean run, non-zero on hard validation errors.

## E. Parity reports

- Row counts by domain: legacy source count vs (future) Postgres target count.
- Missing-ref report (e.g. allocation→job, assignedJobIds→job, evidence link
  targets).
- Timestamp preservation checks (createdAt/updatedAt survive into
  `created_at`/`updated_at`).
- Sample spot checks: N random rows per domain printed source-vs-proposed.
- **Hours checksums (the payroll gate):** total hours by user × ISO week,
  by user × date, ordinary/overtime split, allocation sums vs entry totals,
  internal (`jobId:null`) allocation totals, status counts
  (draft/submitted/approved/rejected) — designed to reconcile the last 4
  closed payroll weeks before any cutover.
- Job/task counts per job (mirroring `api/_lib/job-tasks.js` pooled-count
  rules) and evidence-link counts per entity.
- Stable content hash per domain slice (sorted-key JSON → sha256) so two
  runs — or Blob-vs-Postgres later — can be compared with one string.

## F. Error handling

| Class | Examples | Behaviour |
|---|---|---|
| Hard error (non-zero exit) | malformed JSON, missing required field (no `date` on a time entry), duplicate legacy id within a domain, allocation sums ≠ totals beyond 0.01 | quarantine row + fail the run; nothing would be written |
| Soft warning | unknown extra fields, missing optional timestamps, legacy `snags` array entries, audit blobs at the 5000 trim cap, statuses outside the schema's CHECK list | report + continue; row still importable unless schema CHECK would reject |
| Quarantine bucket | unresolvable user/job/task/evidence refs, orphaned allocations, evidence ids that match nothing | row (or link) held out, listed with reason; import of the rest proceeds |
| Invalid dates | non-`YYYY-MM-DD` entry dates, unparseable ISO stamps | hard error for keys (work_date), warning for metadata stamps |

## G. Execution location — recommendation

**Local operator script under `scripts/importers/` (Node, CommonJS).**

- Matches repo precedent: `scripts/qa/*.js`, root `migrate*.js` one-offs, and
  `scripts/migrate-hours.js` referenced by the hours lib header.
- The env guard's operator path was designed for exactly this
  (`VERCEL_ENV` absent + explicit `SUPABASE_ENV` + write flag).
- Future real writes use the **direct connection string** per Supabase
  guidance (long imports don't belong on the transaction pooler), which a
  Vercel route can't hold safely (timeouts) — rules out API routes.
- GitHub Actions would need Blob + DB secrets in CI for marginal benefit;
  Supabase Edge Functions can't reach Vercel Blob listing efficiently and
  split the operational surface. Both rejected for now.

## H. No production cutover

Importing (when it eventually writes) changes **zero** live app behaviour:
no API route reads Postgres, Blob remains the source of truth for every
surface, and the read/write cutover per domain is a separate later phase
behind per-domain flags (`READ_SOURCE_*` / `WRITE_TARGET_*`) with the
`supabase_dual_write` feature flag already registered (dark) for it.
Kill-switch design belongs to that phase, not this one.

## First importer candidate (recommendation)

**Structure dry-run: tenant + `user_profiles` + `jobs` + `job_members` +
`site_area_groups` + `site_areas` + `job_task_templates` + `tasks`.**

Why (from inspection, not assumption):

1. It is the FK root — every other domain resolves users/jobs through it, so
   its legacy-id map and missing-ref buckets de-risk all later importers.
2. The canonical walk semantics already exist in-repo as pure functions
   (`api/_lib/job-duplicate.js`, `api/_lib/job-tasks.js`) to mirror.
3. Two of its sources are single blobs (`users.json`, `jobs.json`) — the
   cheapest read surface to validate first.

Hours parity is **importer #2**, immediately after: the module is genuinely
isolated (`api/_lib/time-entries.js`), but its allocations reference jobs and
its entries reference users, so it consumes the structure run's ref indexes
rather than rebuilding them.
