# J0 — Jobs/Tasks Supabase Projection Audit (read-only)

> **Status:** J0 audit only — read-only. No data written, no migrations created, no
> Supabase/Blob mutation, no feature flags changed, no production behaviour touched.
> **Audited against:** `origin/main` @ `9c7811c` (the hours trust layer + scheduled
> drift-check merged). **Author:** Claude (Opus 4.8). **Date:** 2026-06-20.
>
> **Companion contracts:** [data-ownership-map.md](../architecture/data-ownership-map.md) ·
> [supabase-storage-migration-adr.md](../architecture/supabase-storage-migration-adr.md) ·
> [supabase-migration-roadmap.md](../architecture/supabase-migration-roadmap.md) ·
> [proof-review-model.md](../architecture/proof-review-model.md).
>
> **Provenance markers used below:** **[PROVEN]** = verified from live DB introspection,
> a read-only live-Blob dry-run, or cited repo code. **[INFERRED]** = reasoned from
> evidence. **[UNKNOWN]** = not verifiable from this read-only audit; needs a live
> dry-run or a decision.

---

## 1. Executive summary

BuhlOS stores a job as **two Blob shapes**: `jobs.json` — a single `jobs[]` array carrying
the full denormalised structure (`areaGroups → areas`, plus job-level and per-area
`roughInTasks`/`fitOffTasks` **templates**) — and per-job `jobs/{jobId}/data.json`, which
holds **task state only** (`dwellings[areaId][stage].tasks[taskId]`), snags and notes. The
target Postgres schema (Phase 1, applied 2026-06-11) matches the live facts exactly:
`jobs`, `site_area_groups`, `site_areas`, `job_task_templates`, `tasks`, `task_status_events`,
with the correct CHECK enums and the identity-bridge unique indexes.

**The task graph is empty everywhere.** DEV and PROD both have **0** rows in
`site_area_groups / site_areas / job_task_templates / tasks / task_status_events`; only DEV
`jobs` has **9** header rows (from the structure importer, PR #585). Only the hours domain
is fully migrated. So the jobs/tasks migration genuinely has not started. **[PROVEN]**

**Task identity is exemplary and unambiguous.** Identity is *always* the tuple
`(areaId, stage, taskId)`, never the bare `taskId`; the in-code `ct_<hash>` is a **derived**
FNV-1a of `jobId::areaId::stage::taskId` (`task-index.ts:124-145`) that is **never stored**,
and it maps cleanly onto `(site_area_id, stage, legacy_template_id) → tasks.id`. The importer
must let Supabase generate `tasks.id` and must populate `legacy_template_id` as the bridge —
minting a competing id is the single largest task-level risk, and it is well-guarded against
by the existing model and the data-ownership contract.

**The importer is split.** The dry-run **planner** (`structure-plan.js`) already walks the
whole graph down to tasks (counts, override-resolution, archive counts, quarantine, tenant-wide
area-id collision detection). The **write-side row builder** (`structure-rows.js`) covers only
`tenant/users/jobs` and *explicitly defers* groups/areas/templates/tasks and `archived→deleted_at`.

**A read-only dry-run against the live Blob is CLEAN** (0 hard errors, 0 duplicate legacy ids,
0 missing refs, 0 invalid records) over 9 jobs, 8 area groups, 32 areas, 17 task templates,
170 task instances (44 complete), 0 archived. **[PROVEN]**

**Verdict: J1 (jobs + site_area_groups + site_areas only) is CONDITIONALLY safe to start** —
the schema, identity model and planner are sound, but three genuine pieces of unbuilt pre-work
gate it (area-id minting rule, the group/area write-side builder, and `archived→deleted_at`).
Most task-level risks (template fusion, ad-hoc tasks, unknown states/stages, proof granularity)
block **J3**, not J1.

---

## 2. Repo safety gate

| Item | Value |
|---|---|
| Working tree | isolated worktree `/Users/oskar/Desktop/birdwood-j0-audit` |
| Branch | `docs/jobs-tasks-j0-audit` (created off `origin/main`) |
| Audited commit | `9c7811c` (= `origin/main` at audit time) |
| Shared checkout state | `/Users/oskar/Desktop/birdwood` is stale at `f3ed021`; **not used** for the audit |
| Tracked dirty files | none |
| Untracked (pre-existing) | `.claude/launch.json`, `.design-cache/`, `.mcp.json`, `docs/supabase-migration-research-audit.md` |
| Other worktrees | `fix/phil-offline-cache-safety`, `feat/task-proof-review-approval` (concurrent sessions — untouched) |
| Open PRs (jobs/tasks/supabase/proof) | #597 Phil offline cache; #574 proof-review admin gate (HMAC); #573 supabase env-guard fail-closed — **none are jobs/tasks importer work** |
| Supabase writes this audit | **none** (read-only introspection + one read-only Blob dry-run) |
| Blob writes this audit | **none** |
| Production behaviour changed | **no** |

Repo state is unambiguous and safe to proceed. The only generated artefacts are this report
and a throwaway facts scratch file (removed before commit).

---

## 3. Current data ownership

Per [data-ownership-map.md](../architecture/data-ownership-map.md): **owner today is Vercel
Blob for every domain**; only `GET /api/supabase-health` touches Postgres so far. The Supabase
schema is *intent*, not live ownership. **[PROVEN]**

Live population (read-only MCP introspection, 2026-06-20):

| Table | DEV `frovgpywsopbeuekijmo` | PROD `wetctlrhsycfwhuxlarv` |
|---|---|---|
| jobs | **9** (header rows, PR #585) | 0 |
| site_area_groups | 0 | 0 |
| site_areas | 0 | 0 |
| job_task_templates | 0 | 0 |
| tasks | 0 | 0 |
| task_status_events | 0 | 0 |
| task_comments / evidence_* / snags / observations / material_requests | 0 | 0 |
| time_entries / time_entry_allocations | 9 / 9 | 0 |

DEV `jobs(9)` all carry tenant **`buhl`** (`tenant_id = 569d0ea3-242e-4f01-8c95-1fe83551e100`),
all with `legacy_id` set. **J1 must reuse this exact tenant** (the same one `structure-rows.js`
mints), never a second one. **[PROVEN]**

---

## 4. Current Blob / job shape

### 4.1 Storage layout **[PROVEN]**

- **`jobs.json`** — a single document holding the `jobs[]` array, each job carrying the full
  nested structure: header fields, `areaGroups[] → areas[]`, job-level `roughInTasks[]` /
  `fitOffTasks[]`, and per-area `area.roughInTasks[]` / `area.fitOffTasks[]` overrides
  (`api/jobs.js:98-99`, `api/_lib/job-create.js:114-136`, `src/domains/jobs/schema.ts:59-206`).
- **`jobs/{jobId}/data.json`** — **task state only**: `dwellings[areaId][stage].tasks[taskId]`
  ∈ `complete | in_progress | not_started`, plus snags and notes. Never the task *definition*
  (`api/data.js:4-46`, `src/domains/jobs/taskState.ts:15-35`, `api/task-toggle.js:8-14`).

**Template vs state is split across the two blobs.** The definition (name, id, archived, order)
lives in `jobs.json`; the live completion state lives in `data.json`. There is **no separate
template-identity object** — the per-area override rule is "use the area's task list if present
and non-empty, else fall back to the job-level list" (`api/_lib/job-tasks.js:23-33`
`effectiveRoughInTasks`/`effectiveFitOffTasks`). **[PROVEN]**

### 4.2 Write paths **[PROVEN]**

- **`jobs.json` writers** (7+): `api/jobs.js` PUT/POST/DELETE (`:654`), `api/jobs-bulk-edit.js`
  (`:269`), `api/job-draft.js` (`:200`), job-templates, `api/cash-watch.js` (`:208`),
  job-circuits, quotes. All are **read-modify-write at the job level** — not full-array
  overwrites — except initial create and delete.
- **`data.json` writer**: exclusively **field-owned patch** via `/api/task-toggle` (mutates one
  task's state then `writeBlob`). The full-document `POST /api/data` was **disarmed in #509**
  and is read-only (`api/data.js:8-21`).
- **Write safety**: `jobs.json` carries `__rev`/`__updatedAt` revision stamping + an
  `expectedRev` stale-write check + a shrink guard (`shrinkField:'jobs'`, `shrinkFloor:10`)
  (`api/_lib/blob-guards.js:111-138`, `api/_lib/blob.js:126-169`). **There is no CAS** (the
  `expectedRev` check narrows but does not eliminate the race), and **`data.json` has no shrink
  guard**. These matter at dual-write/cutover, not at J1.

### 4.3 Field inventory of a job **[PROVEN]**

Present in the Blob job record: `areaGroups`, `areas` (with `spaceType`, `archived`, `order`,
`customFields`), stages (`roughIn`/`fitOff` — implicit via the two task arrays), per-area task
lists, task state (in `data.json`), `customFields` (job + area level). **Not on the Blob task
template:** `requiredPhotoCount` / `requiresNote` (these are PG schema columns with **no Blob
source** — they default to `0`/`false`). Snags, observations, material requests and evidence
links live in **other in-job blobs** (`job-control.json`, `observations.json`, evidence blobs),
not in `jobs.json`/`data.json` — they are later phases (J8), not J1.

### 4.4 Live counts (read-only dry-run vs live Blob) **[PROVEN]**

`node scripts/importers/structure-dry-run.js` (read-only by construction; needs only
`BLOB_READ_WRITE_TOKEN`) against the live Blob:

```
tenants 1 · user_profiles 7 · jobs 9 (4 active / 5 draft) · job_members 6 (0 leads)
site_area_groups 8 · site_areas 32 · job_task_templates 17 · tasks 170
task state: 44 complete, 0 in_progress, 0 unknown · archived: 0 groups / 0 areas / 0 templates
result: CLEAN  (hardErrors 0 · duplicateLegacyIds 0 · missingRefs 0 · invalidRecords 0 · warnings 0)
```

The **17 templates → 170 instances** ratio is the template/instance split materialising on real
data (one task row per effective template per live area per stage). The plan is **clean**, which
means the current live data has **no** cross-job area-id collisions, no duplicate legacy ids, no
missing references and no archived rows today.

---

## 5. Supabase target mapping

Live schema (introspected) for the six focus tables — all carry `id uuid pk`, `tenant_id NN`,
`revision`, `created_at/updated_at NN`, `created_by/updated_by`, `deleted_at/deleted_by`.

| Table | Source Blob fields | Key target columns | Uniqueness (the bridge) | FK deps | Cannot-yet-map / stays Blob |
|---|---|---|---|---|---|
| **jobs** | `jobs.json[i]` header | `legacy_id`=blob `id`, `name`, `status` (enum), `ref`, `job_type_label`, `site_*`, `*_notes`, `induction_required`, `start_date`, `due_date`, `programmed_duration_days`, `modules` jsonb | `jobs_legacy_uq (tenant_id, legacy_id)` | `tenant_id` | `job_type_id`/`client_user_id`/`created_by` (FK-wiring debt); pricing |
| **site_area_groups** | `job.areaGroups[j]` | `job_id`, `legacy_id`=group id, `name`, `sort_order` | `legacy_uq (tenant_id, legacy_id)` | `tenant_id`, `job_id` | — |
| **site_areas** | `group.areas[k]` | `job_id`, `group_id` (nullable), `legacy_id`=**minted** area id, `name`, `space_type`, `sort_order` | `legacy_uq (tenant_id, legacy_id)` ← **tenant-wide** | `tenant_id`, `job_id`, `group_id` | `customFields` (no table) |
| **job_task_templates** | job-level + per-area `roughInTasks`/`fitOffTasks` | `job_id`, `site_area_id` (null=job default / set=area override), `stage`, `legacy_id`=bare `taskId`, `name`, `required_photo_count` (default 0), `requires_note` (default false), `is_active` | `job_legacy_uq (tenant,job,stage,legacy_id) WHERE area NULL` · `area_legacy_uq (tenant,area,stage,legacy_id) WHERE area NOT NULL` | `tenant_id`, `job_id`, `site_area_id` | proof requirements have **no Blob source** → defaults |
| **tasks** | **synthesised**: one per effective template × live area × stage; status from `data.json` | `job_id`, `site_area_id`, `task_template_id` (FK; null=ad-hoc), `stage`, `legacy_template_id`=bare `taskId`, `name`, `status` (default `not_started`), `completed_at/by` | `tasks_area_stage_template_uq (tenant, site_area_id, stage, legacy_template_id) WHERE both NOT NULL` · `tasks_area_template_instance_uq (tenant, site_area_id, task_template_id)` | `tenant_id`, `job_id`, `site_area_id`, `task_template_id` | `completed_at` may be absent in Blob → NULL |
| **task_status_events** | derived (Blob has no changelog) | `task_id`, `from_status`, `to_status`, `source`, `actor_label` | append-only; **no business unique** | `tenant_id`, `task_id` | full transition history (only final state recoverable) |

Transformations of note: status/stage normalise to the schema CHECK enums; `archived:true →
deleted_at/deleted_by`; numbers/dates normalise deterministically; `tenant_id` is the single
`buhl` tenant. **`required_photo_count`/`requires_note` have no Blob source and must default**
(do not fabricate per-task proof requirements). **[PROVEN]**

---

## 6. Task identity audit (the load-bearing section)

### 6.1 The model **[PROVEN]**

- **Identity is the tuple `(areaId, stage, taskId)`** — never the bare `taskId`. The canonical
  index `ct_<hash>` = FNV-1a of `jobId::areaId::stage::taskId` (`src/domains/jobs/task-index.ts:124-145`),
  **derived at runtime, never persisted** anywhere (`task-ref-compat.ts`, `task-ref.ts:40-42`).
- **Bare `taskId` is never treated as globally unique.** It is the *template* id; the same
  `taskId` legitimately repeats across areas and across `roughIn`/`fitOff`. Lookups go through
  the tuple/coordinate adapters, not a bare-id map.
- **`tasks.id` is the durable instance identity** ("`taskInstanceId` is a target term that
  exists nowhere in code; `tasks.id` is its eventual home" — data-ownership-map §0). The
  importer **lets Supabase generate `tasks.id`** and records `legacy_template_id` (= bare
  `taskId`) so the `tasks_area_stage_template_uq` index enforces one row per coordinate.

The identity pin (data-ownership-map.md §0), quoted:

```
tasks.id (uuid, the row PK)
   ↕ resolved at import from
ct_<hash> (canonical task identity — the ONLY tuple→instance authority)
   ↕ derived from
(site_area_id, stage, legacy_template_id)   ← the labelled compatibility bridge
```

### 6.2 Concept → target table

| Concept | Current source | Current code representation | Supabase target | Risk |
|---|---|---|---|---|
| job | `jobs.json[i]` | `Job` (schema.ts) | `jobs.id` (uuid); `legacy_id`=blob id | Low — writer exists; 9 rows in DEV |
| area group | `job.areaGroups[j]` | `JobAreaGroup` | `site_area_groups`; `legacy_id`=group id | Medium — **writer not built**; archived→deleted_at deferred |
| area | `group.areas[k]` | `JobArea` | `site_areas`; `legacy_id`=**minted tenant-unique** | **HIGH (J1)** — blob area.id is per-job-local; PG index tenant-wide |
| stage | `roughInTasks`/`fitOffTasks` (implicit) | `JobStage = 'roughIn'\|'fitOff'` | `tasks.stage` / `job_task_templates.stage` CHECK | Low for known keys; non-standard dwellings keys silently ignored (J3) |
| task template | job-level + per-area task lists | `JobTaskTemplate` (name+id only) | `job_task_templates`; `legacy_id`=bare taskId | Medium (J3) — fusion; proof cols default |
| **task instance** | **derived** (template × live area × stage); state in `data.json` | `CanonicalTask`; `id=ct_<hash>` derived, never stored | **`tasks.id`** (Supabase-generated); `legacy_template_id`=bare taskId | **HIGH (J3)** — must not mint id; must set legacy_template_id |
| task status | `dwellings[areaId][stage].tasks[taskId]` | `TaskState` (taskState.ts) | `tasks.status`; `task_status_events` | Medium (J3) — unknown states warn-only; no changelog |
| task proof | `job-control.json` `requiredEvidence[]`/`evidenceLinks[]` | `RequiredEvidence`; `taskRef` nullable | proof cols on `job_task_templates`; `evidence_links` (0 rows) | Out of J1/J3 scope; area/package-granular |
| task evidence | evidence blobs + `job-control.json`; coordinate-keyed | `EvidenceLink` (nullable `taskRef`) | `evidence_files`/`evidence_links`; re-key to `tasks.id` | Out of J1; re-key by coordinate, never bare taskId |
| task blocker / dependency | `observations.json` (honest-empty, #482) | `TaskBlocker`/`TaskDependency`, keyed by canonical id | no Phase-1 table; future by `tasks.id` | Out of J1; no source to migrate yet |
| task material request | `observations.json` `type='material_request'` | `ObservationItem` → blocker adapter | `material_requests` (0 rows); future by `tasks.id` | Out of J1; separate domain |

### 6.3 Competing-identity hazards

The only real hazard is at **J3 write time**: if the writer mints `tasks.id` itself or forgets
`legacy_template_id`, the `(site_area_id, stage, legacy_template_id)` bridge breaks and every
facet keyed to `tasks.id` (status events, evidence, observations) orphans. **No `ct_<hash>` is
persisted today**, so there is nothing to "preserve" — the importer records the tuple and lets
the unique index do the work. **No code currently risks a third identity.** **[PROVEN]**

---

## 7. Collision / invalid-data audit

Ten risks, tagged by which slice they block. (The live dry-run is CLEAN today, so several are
"latent / future-data" rather than present in the current Blob.)

| # | Risk | Evidence | Impact | Safe handling | Blocks |
|---|---|---|---|---|---|
| 1 | **Area `legacy_id` minting** — blob `area.id` is per-job-local & per-job-LIVE-unique only, but `site_areas_legacy_uq` is tenant-wide | `api/_lib/validation.js:106,129-142` (per-job/live-only, deliberate); `structure-plan.js:145,296-302` (`seenOnce` global, flags cross-job dups → `clean=false`) | Two jobs reusing `apt_001` collide on the tenant-wide unique index; `ct_` includes `jobId` so the app never confused them, masking the latent collision until insert | J1 area writer pre-flights a tenant-wide area-id scan and either mints a job-scoped/composite `legacy_id` or fails the run. **Decide remap-vs-fail before writing.** Current live data has 0 such collisions [PROVEN dry-run] | **J1** |
| 2 | **Group/area write-side builder does not exist** | `structure-rows.js` header lines 6-9 (defers groups/areas; returns only tenant/user/job rows) | J1 cannot write groups/areas | Extend `buildStructureRows` (or add sibling) to emit group/area rows | **J1** |
| 3 | **`archived → deleted_at` unmapped** for groups/areas | `structure-rows.js:18-24` (deferred); planner counts archived but emits no `deleted_at` | Archived areas imported as live → inflated counts, broken `WHERE deleted_at IS NULL` reads | Map `archived:true → deleted_at=now(), deleted_by=system-uuid`; post-validate count parity | **J1** |
| 4 | **No true Blob CAS** — concurrent `jobs.json` writers can lose a write despite revision guard | `api/_lib/blob.js:126-169`; `blob-guards.js:49-57` | Dual-write window divergence; inherent to Blob, not the importer | Run J1 single-instance; the sync_check is the trust layer; Postgres CAS is the cutover fix | J5+ |
| 5 | **Importer mints competing `tasks.id` / forgets `legacy_template_id`** | `task-index.ts:124-145`; live-facts | Bridge breaks; facets orphan | J3 writer: never set `tasks.id`; always set `legacy_template_id`; let the unique index enforce | J3 |
| 6 | **Template fusion** — per-area override + job-level default both materialise | `api/_lib/job-tasks.js:23-33`; `structure-plan.js:44-49` | Inflated totals / wrong effective task | Reuse `effectiveEntries` (already correct in planner) in the J3 writer | J3 |
| 7 | **Ad-hoc tasks** (state for a `taskId` with no effective template) treated as `missingRefs`, not instantiated | `structure-plan.js:235-243`; schema supports ad-hoc (`task_template_id NULL`) | Recorded progress on one-offs dropped / run fails | J3 adds ad-hoc path: `task_template_id NULL`, `legacy_template_id=taskId`; distinct quarantine bucket | J3 |
| 8 | **Unknown task states warn-only; non-standard stage keys silently ignored** | `structure-plan.js:250-253` (warn → import as `not_started`); `:243-244` (walks fixed `STAGE_KEYS`, never enumerates `dwellings` keys) | State silently lost (wrong stage key) or coerced without a decision | J3: enumerate `dwellings[areaId]` keys and quarantine unknown stages; explicit state-normalisation map; default-to-`not_started` only as a logged choice | J3 |
| 9 | **No shrink guard on `data.json`** (task-state source) | `blob-guards.js` registers no `data.json` shrink entry — `applyGuards` runs on every `writeBlob` (`blob.js:145`) but skips the shrink check for keys with no `shrinkField` config | A truncating write could drop `dwellings` pre-migration with no audit (low probability, high blast radius) | Snapshot `data.json` before migration; the J3 sync_check count-compare catches truncation; optional shrink guard | non-blocking |
| 10 | **`task_status_events` backfill is one-way** (only final state) and FK-ordered after tasks | live-facts; `task-toggle.js` | Worker transition history incomplete; FK fails if written before tasks | J3: one synthetic `from→to` event per task; import order templates → tasks → events; accept history loss; document in runbook | J3 |

**Net: only risks 1–3 block J1; the rest block J3 (or are dual-write/cutover concerns).**

---

## 8. Jobs/tasks sync-check design (design only — not implemented)

Build `api/_lib/structure-sync-report.js` as a **pure** function mirroring
`api/_lib/hours-sync-report.js` (`buildHoursSyncReport`) exactly in shape, re-exported to
`scripts/importers/lib` so a scheduled cron route and a manual runner share **one** source of
truth (the hours #152 trust-layer pattern). Both sides are normalised to a common comparison
shape before hashing, so a JS number and a numeric string agree and irrelevant metadata cannot
forge drift.

**Sections compared** — each with its own business key, a per-side `sha256` dataset hash, a
PASS/FAIL, and counts `matched / onlyInBlob / onlyInPg / mismatched (/ unmappable)`:

1. **Jobs** — key = job `legacy_id`. Tuple: `[legacy_id, name, status(norm), ref|null,
   job_type_label|null, site_address|null, induction_required(bool|null), start_date|null,
   due_date|null, programmed_duration_days|null, deleted(bool)]`.
2. **Area groups** — key = group `legacy_id`. Tuple: `[legacy_id, job_legacy_id, name,
   sort_order, deleted]`.
3. **Areas** — key = area `legacy_id` (the **minted** id, not raw blob id). Tuple:
   `[legacy_id, job_legacy_id, group_legacy_id|null, name, space_type|null, sort_order,
   deleted]`. A separate **`unmappable`** bucket flags any blob area whose id could not be
   deterministically mapped to a PG `legacy_id`.
4. **Task templates** — key = `(job_legacy_id, site_area_legacy_id|'JOB', stage, legacy_id)`
   mirroring the two partial unique indexes. Tuple includes `name, required_photo_count(0),
   requires_note(false), is_active, deleted`; report the job-level vs area-override split.
5. **Task instances** — key = `(site_area_legacy_id, stage, legacy_template_id)` = the
   `tasks_area_stage_template_uq` bridge. The Blob side reconstructs the **expected** set via
   `effectiveEntries(job,area,stage) × live areas` (reusing the planner so the check matches the
   writer's materialisation rule) plus `dwellings` state; the PG side reads `tasks`. Tuple:
   `[site_area_legacy_id, stage, legacy_template_id, name, status(norm),
   task_template_id_present(bool — ad-hoc vs template-linked), deleted]`. Report `unmappable`
   (a blob `taskId` with no derivable coordinate / no live area).
6. **Status totals** — independent cross-check: count by `{not_started, in_progress, complete}`
   must match per side (the analogue of hours `sumTotal`).
7. **Rough-in / fit-off split** — count by stage per side, and the status breakdown within each
   stage, so a stage-keying bug surfaces even if the grand total happens to align.

**Determinism:** each section's hash = `sha256` over the **sorted** array of canonical tuples
(sort by the section business key, exactly as `datasetHash` sorts in `hours-sync-report.js`).
Numbers rounded deterministically, nulls via `strOrNull`, booleans canonicalised, status/stage
from the fixed enum lists. **Exclude volatile metadata** from every tuple: `id`(uuid),
`revision`, `created_at/updated_at`, `created_by/updated_by`, `completed_at/by`, `assigned_to`,
`sort_order` where it is not load-bearing, `tenant_id` (single-tenant), `modules`. `hashMatch`
(`blobHash === pgHash`) is reported as an **independent** cross-check of the per-key verdict.
**Overall PASS iff every section has zero `onlyInBlob`, `onlyInPg`, `mismatched`, `unmappable`.**
The result records into `public.sync_checks` with the same record shape used by hours (status,
counts, hashes, capped detail lists). This is the **J1 (and later J3) acceptance gate**.

---

## 9. Proposed J1–J9 migration ladder (design only)

Order matches the prompt's expected ladder and the FK dependency chain
(`jobs → groups/areas → templates → tasks → events`).

| Slice | Scope | Files likely touched | Acceptance | Tests | Rollback | Risks | Touches prod? |
|---|---|---|---|---|---|---|---|
| **J1** | jobs (done) + **groups + areas** writer; mint tenant-unique area `legacy_id`; `archived→deleted_at`; **structure sync_check** (jobs/groups/areas sections) as PASS gate. No templates/tasks. | `structure-rows.js` (extend), `structure-import.js`, NEW `api/_lib/structure-sync-report.js` (+re-export, +test) | dry-run `clean=true`; sync_check PASS for jobs/groups/areas; PG `deleted_at NOT NULL` count = blob archived count | extend `structure-import-plan.test.ts`; new `structure-sync-report.test.ts` (PASS + each drift bucket); tenant-wide area-id collision test | idempotent upsert on `legacy_id`; delete tenant's group/area rows & re-run; jobs(9) untouched | area-id minting decision; group/area writer unbuilt; archived mapping | **no** |
| **J2** | `job_task_templates` writer (job-level + per-area override via `effectiveEntries`); proof cols default `0`/`false`; `archived→deleted_at`; sync_check §4 | `structure-rows.js`, `structure-import.js`, `structure-sync-report.js` | template count + job/area split match; both partial uniques hold; §4 PASS | duplicate-per-scope; override-vs-default fixture; archived template | idempotent upsert; delete tenant's templates | duplication is correct (don't de-dup); empty override = default | **no** |
| **J3** | `tasks` writer: one row per effective template × live area × stage; Supabase-generated id; set `legacy_template_id`; map state→status; ad-hoc path; unknown-state + unknown-stage quarantine; sync_check §5/6/7 | `structure-rows.js`, `structure-import.js`, `structure-sync-report.js`, `structure-plan.js` (ad-hoc + dwellings-key enumeration) | task count + status totals + stage split match; bridge index holds; ad-hoc instantiated not dropped; PASS | same-taskId across areas / across stages (distinct rows); ad-hoc; unknown state; non-standard stage key | idempotent on `(site_area_id,stage,legacy_template_id)`; delete tenant's tasks | the full task-level risk surface (#5–#8, #10) | **no** |
| **J4** | `task_status_events` backfill (one synthetic event per task, proxy ts; FK-ordered after tasks) | `structure-import.js`, `structure-rows.js` | one event per qualifying task; FK valid | event-per-task count; FK ordering | delete tenant's events (append-only) | history loss (final state only) | **no** |
| **J5** | **dual-write** for jobs/area/task writes behind `supabase_dual_write`; PG txn + outbox in same tx; Blob best-effort; drift alarm; honest "didn't save" on PG failure | `api/jobs.js`, `api/task-toggle.js`, `supabase-db.js`, `feature-flags.js` | flag on → write lands PG+Blob; drift alarm on divergence; P7-honest failure | dual-write success; PG-fail→honest fail; Blob-fail→alarm | flag off → blob-only | **first prod-touching slice**; Blob CAS gap; concurrency | **yes** |
| **J6** | scheduled structure sync_check cron → records `sync_checks`, alerts on FAIL (mirrors hours cron + `/sync-status`) | NEW `api/internal/sync-checks/structure` route; `structure-sync-report.js` | cron records PASS/FAIL; FAIL alerts | cron handler test; record shape | disable cron entry | read-only; touches prod scheduling | **yes** |
| **J7** | pg-read with blob-fallback for jobs/tasks reads, flag-gated; only after sustained PASS | `api/data.js`, `api/jobs.js` read paths, `src/domains/jobs` read model | PG-read parity with blob-read; fallback on miss/error | pg-read parity; fallback | flag off → blob-read | read divergence; gated on PASS | **yes** |
| **J8** | re-key evidence/snags/observations/material_requests from in-job blobs to `tasks.id` via coordinate (never bare taskId) | new importers; `structure-sync-report.js` new sections | each resolves to exactly one `tasks.id`; sync_check PASS | coordinate→tasks.id resolution; no cross-area false match | delete migrated rows | source is blob not empty PG; false-match if bare taskId | **no** |
| **J9** | pg-only cutover: drop blob-fallback; PG authoritative; retire blob write path for jobs/tasks; only after prolonged PASS + dual-write soak | `api/jobs.js`, `api/data.js`, `api/task-toggle.js`, `blob-guards` | all jobs/tasks reads+writes PG-only; sync_check archived | full e2e PG-only | re-enable dual-write/fallback (keep blob through soak) | point of no easy return; needs CAS | **yes** |

**J1–J4 are read-from-Blob/write-to-PG operator imports — no production behaviour change.**
The first prod-touching slice is **J5** (dual-write).

---

## 10. Blockers before J1

1. **Decide & document the area `legacy_id` minting rule.** Blob `area.id` is job-local and
   per-job-live-unique only (`validation.js:106,129-142`); `site_areas_legacy_uq` is tenant-wide.
   The planner already *detects* cross-job collisions (`seenOnce`) but currently **quarantines
   them as `duplicateLegacyIds` and sets `clean=false`** — i.e. it would *fail*, not remap.
   Choose **remap (job-scoped/composite id) vs fail-the-run** before writing. *(Live data has 0
   such collisions today — [PROVEN] — so either choice is safe now; the decision is for
   robustness/future data.)*
2. **Extend the write-side row builder** (`structure-rows.js`) to emit group + area rows. The
   planner is ready; the writer is not.
3. **Map `archived → deleted_at`** on the group/area writer (currently deferred).
4. **Designate a system actor** for `deleted_by` (and decide whether `created_by/updated_by`
   stay NULL or get a system uuid) for imported rows.
5. **Reuse the existing `buhl` tenant** (`569d0ea3-242e-4f01-8c95-1fe83551e100`) the DEV jobs(9)
   already carry — do not mint a second tenant, or the `(tenant_id, job_id)` FKs won't resolve.
   *(Confirmed [PROVEN].)*
6. **Build the structure `sync_checks` engine** (§8) and make J1 acceptance = PASS, exactly as
   hours did for #152.

---

## 11. Open questions

| # | Question | How to resolve | Status |
|---|---|---|---|
| 1 | Does any production job reuse the same bare `area.id` across two jobs? | live-Blob dry-run | **CLOSED [PROVEN]** — current data is CLEAN (0 cross-job dups). Decision still needed for future data. |
| 2 | What tenant do DEV jobs(9) carry, and is it the `buhl` slug tenant? | MCP introspection | **CLOSED [PROVEN]** — yes, `buhl` / `569d0ea3-…e100`, all 9 with `legacy_id`. |
| 3 | Does the Blob carry non-standard stage keys (`rough-in`, `rough_in`, `prewire`) in `dwellings`? | live dry-run with key-enumeration | **OPEN** — planner walks fixed `STAGE_KEYS` (`structure-plan.js:226,232`) and would **silently ignore** unknown stage keys. J3 must enumerate + quarantine. |
| 4 | Are there task states outside `not_started/in_progress/complete`? | live dry-run | **OPEN** — planner warns and imports as `not_started` (`:259-261`); J3 must decide quarantine vs default. Quantity unknown. |
| 5 | Do ad-hoc tasks (state for a `taskId` with no effective template) exist? | live dry-run | **OPEN** — planner treats as `missingRefs` (`:251-256`); schema supports ad-hoc. J3 must instantiate vs quarantine. Quantity unknown. |
| 6 | Will evidence/snags/observations/materials migrate from the in-job blobs (not the empty PG tables), re-keyed coordinate→`tasks.id`? | J8 design | **OPEN** — confirmed blob-sourced (0 PG rows); re-key path unbuilt. |
| 7 | Does the Blob record a per-task completion timestamp, or only the state string? | inspect `data.json` | **OPEN** — `tasks.completed_at` is nullable; J3 leaves NULL or uses a proxy. |

*(Questions 3–5 are best answered by running the planner with added dwellings-key/ad-hoc
enumeration during J3 prep; they do not block J1.)*

---

## 12. Constitution Impact

This is an **architecture/migration direction**, not a Phil-constitution amendment; Phil's
place-first navigation as a view is untouched.

| Question | Answer | Justification |
|---|---|---|
| Preserves task-led architecture? | **Yes** | Records identity as `(site_area_id, stage, legacy_template_id) → tasks.id` — the task-led spine; areas/groups become *facets* (`site_areas`/`site_area_groups`), not task owners. |
| Avoids deepening area-owned task state? | **Yes** | The importer *reads* the existing area-nested arrays via the labelled `effectiveEntries` rule and *flattens* them into first-class `tasks`/`job_task_templates`. It adds **no new writes** that deepen area-owned arrays. |
| Avoids a third task identity? | **Yes** | `ct_<hash>` is derived and never stored; the importer lets Supabase generate `tasks.id` and records `legacy_template_id` as the documented bridge. No third mapping table. |
| Keeps BuhlOS/Phil naming correct? | **Yes** | Uses BuhlOS (office) / Phil (field) and real schema/table names; `taskInstanceId` treated as a *target* concept realised as `tasks.id`, not claimed as existing code. Switchboard not used. |
| Identifies temporary bridge logic clearly? | **Yes** | The `(jobId,areaId,stage,taskId) → tasks` bridge and the per-job-vs-tenant area-id layering are explicitly labelled compatibility bridges (matching `validation.js` and the data-ownership map). |
| Avoids overclaiming readiness? | **Yes** | States plainly that the write-side group/area/task builders **do not exist**, the task graph is **empty** in PG, no admin proof approve/reject UI exists, and per-task proof is unauthored in prod. J1 is **conditional**, not "ready". |
| Leaves proof granularity honest? | **Yes** | Proof is area/package-granular in prod with per-task plumbing merged but unauthored, `evidence_links=0` in PG (Blob is source) — matches `proof-review-model.md` and the live counts. No per-task or admin-approval overclaim. |

---

## Appendix — method & evidence base

- **Live DB introspection** (read-only, Supabase MCP) of dev `frovgpywsopbeuekijmo` + prod
  `wetctlrhsycfwhuxlarv`: row counts, column definitions, unique indexes, tenant resolution.
- **Read-only live-Blob dry-run** via `scripts/importers/structure-dry-run.js` (read-only by
  construction; `BLOB_READ_WRITE_TOKEN` only) → the §4.4 counts + CLEAN verdict.
- **Repo evidence** gathered by a 5-lens read-only investigation (storage shape, task identity,
  proof/QA coordinates, target schema + framework reuse, collision scan) + cross-lens synthesis;
  every claim above is cited to `file:line` or to a live fact. Five cross-lens conflicts were
  reconciled by re-reading the cited files (notably: the planner *is* built for the full graph
  while the *writer* is not; the area-id layering is deliberate, not a bug).
