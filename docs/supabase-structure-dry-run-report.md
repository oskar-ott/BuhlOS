# Structure dry-run — findings & parity report

**Run date:** 2026-06-12 (AEST)
**Command:** `node scripts/importers/structure-dry-run.js` (and `--json` for bucket detail)
**Importer:** [scripts/importers/structure-dry-run.js](../scripts/importers/structure-dry-run.js) · planner [lib/structure-plan.js](../scripts/importers/lib/structure-plan.js)
**Source:** live Vercel Blob (production), read-only.
**Result:** **CLEAN — exit 0.** No quarantined rows, no warnings, no hard errors.

## Environment assumptions

- Read token: **`BLOB_READ_WRITE_TOKEN`** (present in `.env.local`, 64 chars).
  The token name includes "write", but the importer imports **only**
  `readBlob` (list + fetch); no write function is reachable.
- No `SUPABASE_*` variables were set during the run — the importer printed
  `SUPABASE_ENV: (not set)` / `SUPABASE_PROJECT_REF: (not set)` and performed
  **zero** Supabase access (dry-run needs none).
- Token-loading note (operator ergonomics, **not** a code issue): the value
  in `.env.local` is double-quoted (a `vercel env pull` artifact). Passing it
  raw includes the literal quotes and Vercel returns *"Access denied"*. It
  must be loaded with quotes stripped (or via a dotenv-aware loader). The
  first attempt failed this way; the second, with quotes stripped, succeeded.

## Confirmation of zero writes

- **Supabase writes: zero.** No DB client exists in the importer; SUPABASE
  env was unset; verified after the run that `public` still has **31 tables /
  0 live rows** (read-only count). DB remains empty and untouched.
- **Vercel Blob writes: zero.** The importer imports only `readBlob`; grep +
  the unit test's source-level scan confirm no `writeBlob`/`deleteBlob`/
  `put(`/`@vercel/blob` reference in any importer module.
- No source data modified, no migrations applied, no API routes touched, no
  production behaviour changed, `--write` never passed.

## Source Blob files read

| Blob key | Result |
|---|---|
| `users.json` | 7 users |
| `jobs.json` | 8 jobs |
| `jobs/<jobId>/data.json` × 8 | 8 per-job state blobs (task completion) |

## Summary counts (proposed inserts — nothing written)

| Target table | Inserts | Updates |
|---|---:|---:|
| tenants | 1 | 0 |
| user_profiles | 7 | 0 |
| jobs | 8 | 0 |
| job_members | 5 | 0 |
| site_area_groups | 7 | 0 |
| site_areas | 31 | 0 |
| job_task_templates | 16 | 0 |
| tasks | 169 | 0 |

Updates are 0 because the target is known-empty; idempotent re-runs would
match on `legacy_id` and report updates instead.

### Discovery detail

- **Jobs:** 8 — statuses `{active: 3, draft: 5}` (all pass the schema CHECK).
- **Users:** 7 — roles `{admin: 2, tradie: 4, client: 1}` (all schema-valid).
- **Job members:** 5 memberships from 4 distinct assigned users
  (`{tradie: 3, client: 1}` have `assignedJobIds`) — i.e. one tradie is on two
  jobs. **0 leads** (no `leadinghand`-role user in this dataset).
- **Area groups:** 7 · **Areas:** 31 (0 archived).
- **Job task templates:** 16 (job-level defaults + per-area overrides).
- **Task instances:** 169 proposed; **43 complete**, 0 in-progress, 0 unknown.
- **hourlyRate** set on 4 / 7 users.

## Quarantine table

| Bucket | Count |
|---|---:|
| Hard errors | 0 |
| Invalid records | 0 |
| Invalid statuses | 0 |
| Invalid member roles | 0 |
| Invalid task states | 0 |
| Duplicate legacy IDs | 0 |
| Missing user references | 0 |
| Missing job references | 0 |
| Warnings | 0 |

Nothing quarantined — every row in the current production (Birdwood) dataset
imports cleanly under the Phase-1 schema CHECKs.

## Semantic-correctness checks

- **Counts align with `api/_lib/job-tasks.js`:** the planner reuses the exact
  effective-checklist rule (non-empty area override wins; archived entries
  excluded; job-level default otherwise) and is parity-tested in
  `src/domains/importers/structure-import-plan.test.ts`. The 169 task figure
  is produced by that same rule applied to live areas × stages.
- **Empty task-override arrays handled as "use job default":** yes — verified
  by unit test and applied to real data (no area produced a spurious empty
  checklist or a missing-template quarantine).

## Data-shape surprises

1. **The anticipated "leading hand" role normalisation did _not_ appear.**
   All 7 production users carry schema-valid roles; there are zero
   `leadinghand`/`"leading hand"` spellings in *this* dataset. The
   normalisation map is still worth keeping as a guard (memory notes legacy
   LH spellings exist on some live accounts elsewhere), but it is **not**
   blocking for the current Birdwood tenant.
2. **A `client`-role user has `assignedJobIds`** and would therefore become a
   `job_member`. Schema-legal, but worth a human confirm: is the client meant
   to be a job member, or should client linkage be only the portal
   `clientUserId`? (Not an importer error — flagged for product review.)
3. **0 leads in the membership set** means the `job_members.role='lead'` path
   (LH approver scope) is unexercised by this dataset — fine here, but the
   lead-mapping logic won't get real-data coverage until a tenant with
   assigned leading hands is imported.
4. **Small dataset** (7 users / 8 jobs / 31 areas / 169 tasks): this is the
   Birdwood demo/seed tenant, an ideal low-risk first proving slice — but not
   representative of large-tenant volumes or edge cases.

## Normalisation TODOs

- **Keep** the role-normalisation guard (legacy `leading hand` → `leadinghand`
  etc.) for future/legacy accounts, even though current data is clean.
- **Decide** product intent for client-role users with `assignedJobIds`
  (member vs portal-only) before the structure cutover.
- **Operator ergonomics (optional, separate task):** teach the importer to
  load `.env.local` with quote-stripping so operators don't hit the
  "Access denied" quote artifact. Code change — out of scope for this
  read-only task.

## Recommended next fixes

None are blocking. Before the *first non-production* Supabase write:
1. Stand up the dev/staging Supabase project + per-environment Vercel vars
   ([docs/supabase-environment.md](supabase-environment.md)).
2. Resolve the two product questions above (client-membership; lead coverage).
3. Build importer #2 (hours parity dry-run) and run it read-only too, so the
   payroll-critical domain is proven before any structure write.

## Go / no-go for the first non-production Supabase write (later)

**GO for a _dev-project_ structure write, gated** on: (a) the dev project +
guarded env existing, and (b) the two product confirmations above. The data
itself is clean and import-ready under the Phase-1 schema. **NO-GO for any
production write** — that remains far downstream behind dual-write burn-in and
the hours parity gate. This run touched nothing and changes that calculus only
by proving the structure slice imports cleanly.
