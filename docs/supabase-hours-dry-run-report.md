# Hours parity dry-run — findings & parity report

**Run date:** 2026-06-12 (AEST)
**Commands:** `node scripts/importers/hours-dry-run.js` and `--json`
**Importer:** [scripts/importers/hours-dry-run.js](../scripts/importers/hours-dry-run.js) · planner [lib/hours-plan.js](../scripts/importers/lib/hours-plan.js)
**Source:** live Vercel Blob (production), read-only.
**Result:** **CLEAN — exit 0.** Zero quarantine across all 14 validation buckets.

## Environment assumptions

- Read token **`BLOB_READ_WRITE_TOKEN`** (present in `.env.local`, double-quoted
  `vercel env pull` artifact — loaded with quotes stripped in a subshell, never
  printed/written/committed).
- No `SUPABASE_*` vars set; importer printed `SUPABASE_ENV: (not set)` and did
  zero Supabase access (dry-run needs none).

## Confirmation of zero writes

- **Supabase writes: zero.** No DB client exists; verified after the run that
  `public` still has **31 tables / 0 live rows**. DB untouched.
- **Vercel Blob writes: zero.** The importer uses only the read-only `list`
  (enumeration) + `fetch`/`readBlob` (reads); `@vercel/blob` is destructured as
  exactly `{ list }`, so `put`/`del` are never imported. A source-level test
  asserts no write call exists in any importer module.
- No source data modified, no migrations applied, no API route touched, no
  payroll logic changed, `--write` never passed.

## Phase-1 audit: canonical hours surface (current repo state)

Audited against the latest tree (incl. recent origin merges #400 weekly export,
#402 overtime-on-split-day CSV, #358 reopen-from-weekly):

| Concern | Finding |
|---|---|
| **Canonical hours source** | `users/{userId}/time-entries/{date}.json` — exactly one entry per user per day (`api/_lib/time-entries.js`; schema unique `(tenant_id,user_id,work_date) WHERE deleted_at IS NULL`). |
| **Legacy / non-source** | `jobs/{jobId}/hours.json` (deprecated `/api/hours`) — **not** a source. Per-user `time-entries-audit/{yyyy-mm}.json` is the append-only hours audit → maps to `audit_logs` later, out of this slice. |
| **Entry shape** | `{ id, date, totalHours (0<t≤16), ordinaryHours, overtimeHours, status, allocations[], submittedAt?, approvedBy/At?, rejectedBy/At?, rejectedReason?, exportId?, exportedAt?, __rev }`. |
| **Allocation shape** | `{ jobId|null, hours, notes?, jobName? }`; `jobId:null` = "Internal (no job)" (real, not an error); Σ allocation hours = totalHours (±0.011). |
| **Statuses** | `draft \| submitted \| approved \| rejected`. |
| **Week start** | Monday, ISO, UTC arithmetic (`weekStartOf` in `src/domains/timesheets/service.ts`); schema `timesheet_approvals.week_start_date` enforces `isodow = 1`. |
| **OT rule** | ordinary = first 8h, overtime = excess (`autoSplitOT`); `ordinary + overtime = total`. |
| **Payroll runs** | `payroll-runs.json` `{ runs: [{ exportId, hash, actor, actorName, at, range:{fromDate,toDate,status}, userId, jobId, rowCount, summary }] }`, append-only, written by `/api/time-entries-export` on a committed (non-dryRun) export. |
| **Weekly closeout** | **Projection-only** — no durable store. `timesheet_approvals` is therefore imported as **empty by design**. |
| **reopen/reject/approve** | approve→approvedBy/At; reject→rejectedBy/rejectedReason; reopen (admin) approved/rejected→submitted/draft, blocked if `exportId` set unless `force`. |

## Source Blob files read

| Blob key | Result |
|---|---|
| `users.json` | 7 users |
| `jobs.json` | 8 jobs (allocation job-ref validation) |
| `users/<id>/time-entries/<date>.json` × 7 | 7 day entries (1 worker) |
| `payroll-runs.json` | **absent** — no committed payroll export has ever run in prod |

## Summary counts (proposed inserts — nothing written)

| Target table | Inserts | Note |
|---|---:|---|
| time_entries | 7 | |
| time_entry_allocations | 7 | one allocation each — no split days in real data |
| payroll_runs | 0 | `payroll-runs.json` absent |
| timesheet_approvals | 0 | projection-only — stays empty by design |

### Parity numbers

- **Users:** 7 total; **1 with entries** (`u_mnxp66x9jl6h`).
- **Dates:** 7 · **Week-starts:** 3 (`2026-05-25`, `2026-06-01`, `2026-06-08`), all Mondays.
- **Entries by status:** approved 7, submitted 0, draft 0, rejected 0.
- **Hours:** total **55.6** = ordinary **53.6** + overtime **2** (reconciles).
- **Allocations:** total **55.6**, internal/no-job **7.6**; **entry-total vs allocation-total delta = 0**.
- **Hours by user×week:** `u_mnxp66x9jl6h` → 7.6 (wk 05-25), 7.6 (wk 06-01), 40.4 (wk 06-08).
- **Hours by job×week:** `birdwood-iv3232` → 7.6 (wk 06-01) + 40.4 (wk 06-08); `__internal__` → 7.6 (wk 05-25).
- **Status hours by week:** every week 100% approved.
- **Payroll runs:** 0.

## Quarantine table

| Bucket | Count |
|---|---:|
| Hard errors | 0 |
| Quarantined entries | 0 |
| Missing user refs | 0 |
| Missing job refs | 0 |
| Duplicate user+date | 0 |
| Invalid dates | 0 |
| Invalid statuses | 0 |
| Invalid hour totals | 0 |
| ordinary+overtime ≠ total | 0 |
| Over-16h days | 0 |
| Allocation sum ≠ total | 0 |
| Week-start not Monday | 0 |
| Reopen/approval inconsistencies | 0 |
| Warnings | 0 |

Every entry reconciles: totals, OT split, allocation sums and Monday week-starts
all valid. Nothing quarantined.

## Payroll-run & weekly-approval findings

- **Payroll runs:** `payroll-runs.json` is **absent** — no committed payroll
  export has ever executed in production. `payroll_runs` imports nothing today.
- **Weekly/timesheet approvals:** confirmed projection-only (no durable store);
  `timesheet_approvals` is correctly proposed empty. It only begins filling if/when
  durable closeout writes are added (a future feature, not an import concern).

## Data-shape surprises

1. **Only 1 of 7 users has any logged hours** — this is the light Birdwood
   seed/demo tenant, not representative of production volume.
2. **No committed payroll runs exist** — so the *strongest* hours-cutover gate
   ("reconcile the last N closed payroll weeks") **cannot be exercised yet**;
   there is nothing closed to reconcile against. This is the single most
   important caveat for the cutover plan.
3. **No split-day, draft, submitted or rejected entries in real data** — every
   entry is single-allocation and approved. So the multi-job/overtime-split
   path (#402), the reject/resubmit path, and the reopen path are **unexercised
   by real data** (they are covered by synthetic unit tests, not production).
4. **One internal/no-job day** (7.6h, wk 05-25) imports cleanly as `jobId:null`.
5. Job slug `birdwood-iv3232` resolves against `jobs.json` — no missing refs.

## Normalisation TODOs

- **None for hours.** Unlike the structure slice (legacy `"leading hand"` role
  spelling), the hours data needs no normalisation — it is schema-clean as-is.

## Recommended next fixes

None are blocking. Before the *first non-production* Supabase hours write:
1. Stand up the dev/staging Supabase project + per-environment Vercel vars
   ([docs/supabase-environment.md](supabase-environment.md)).
2. Accept that real-data coverage is thin: split-day, rejected/draft and
   payroll-run paths are tested only synthetically. Either seed a richer dev
   dataset or re-run this parity after more production usage before trusting
   those paths in a write.
3. Keep `timesheet_approvals` out of the importer (projection-only).

## Go / no-go for the first non-production Supabase write (later)

**GO for a _dev-project_ hours write, gated** on the dev project + guarded env
existing. The current production hours data is clean and import-ready: 7
entries, perfect total/OT/allocation reconciliation, zero quarantine.

**NO-GO for any production hours write** — and beyond the standing dual-write
burn-in requirement, note a domain-specific blocker: the payroll-week
reconciliation gate has **no closed payroll runs to reconcile against yet**
(`payroll-runs.json` absent). That gate must be satisfiable — i.e. real payroll
must have run at least once — before a production hours cutover can be trusted.
This read-only run changes the calculus only by proving the structure of the
hours slice imports cleanly.
