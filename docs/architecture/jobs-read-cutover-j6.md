# J6 — Admin jobs read cutover (dark flag)

Part of the Blob→Postgres migration (#152, J-series). J5 proved the Postgres
graph can be reconstructed back into the Blob/job shape. J6 is the first
**behaviour-capable read slice**: the **admin/office** jobs read can be served
from Postgres behind a flag, **without changing what the office sees**. Phil and
clients are untouched.

## Hard constraints

- **Blob stays authoritative.** Postgres is optional; any error → automatic Blob
  fallback. The office never loses access if Postgres is down.
- **Admin only.** The cutover is gated on the admin tier (`isAdminRole`). The
  field/leading-hand/client paths read pure Blob, exactly as before.
- **Dark by default.** Flag `supabase_read_jobs` defaults OFF and is unset in
  production, so production behaviour is unchanged.
- **No writes.** No Blob writes, no Supabase writes, no schema/importer changes.

## Why an overlay, not a swap

Two realities make a straight "read jobs from PG instead of Blob" unsafe:

1. **Jobs are not dual-written** (only hours is). Postgres is a *frozen snapshot*
   from the last importer run, so any job edited since has drifted.
2. **Admin consumes Blob-only fields** Postgres never stored — `modules`,
   `customFields`, `scopeOfWork`, `clientUserId` — and **existence is
   Blob-authoritative** (new/draft jobs live only in Blob; some legacy areas are
   minimal `{id,name}` records).

So Postgres never *replaces* the Blob read — it **overlays** it, per job.

## Serve policy (per-job, parity-gated)

The Blob read is the spine. For each job:

- present only in Blob (new/draft) → **served from Blob**;
- present in both, PG **byte-faithful** to Blob on the migrated fields → migrated
  fields **served from Postgres** (Blob-only fields preserved);
- present in both but **drifted** (edited since import, or legacy
  ordering/shape) → **served from Blob**;
- present only in Postgres (stale) → **never served** (Blob = existence).

"Faithful" = an order-sensitive, key-order-normalised hash of the migrated
fields (`MIGRATED_JOB_FIELDS`) matches between Blob and PG. The overlay only
writes keys the Blob job already has, so the served key-set is identical to
Blob's. The result is therefore **semantically identical to Blob** — same jobs,
same values, same order — differing at most in nested JSON key ordering, which no
consumer depends on. `createdAt` is excluded (PG's timestamp `::text` form
differs from the Blob string and is meaningless to cut over).

The single reconstruction engine is `api/_lib/job-read-projection.js`
(`reconstructFromPg` / `loadJobStructureFromPg`); the J5 queries now `ORDER BY
sort_order` so reconstruction is deterministic. The seam is one block in
`api/jobs.js` after the Blob read.

Notes / known limitations:

- `startDate`/`dueDate` are PG `DATE` columns read as `::text` (`YYYY-MM-DD`),
  matching the Blob string form (verified on the dev dataset — the only drift
  observed was `areaGroups`/task-list ordering, never dates). If a legacy Blob
  job ever stored an ISO timestamp there, it would simply hash-differ and that
  job would fall back to Blob — never wrong, just not PG-served.
- Tenant is the single `buhl` slug today (the only tenant). It is an injectable
  dep defaulting to `'buhl'`; multi-tenant would thread the real slug through the
  seam.

## Diagnostics

- `GET`-time, no writes: each admin read records a process-local counter
  (`api/_lib/job-read-diagnostics.js`) and emits a structured log. These reset on
  cold start and are not aggregated across instances (the slice writes nothing to
  persist them).
- Admin page **`/jobs-read-status`** runs a live, read-only probe
  (`probeAdminJobsRead`) and shows: current read source, flag state, projection
  PASS/FAIL, live parity hash match, per-job faithful/drift/new/stale counts,
  latency, and the process-local fallback counter.

## Dev validation (against the dev project, read-only)

Flag OFF → Blob (DB untouched); Flag ON → PG overlay, output semantically ==
Blob; simulated PG outage → Blob fallback; simulated projection failure → Blob
fallback; diagnostics probe → reads live. On the dev dataset 3/9 jobs were
byte-faithful (served from PG); the other 6 differ representationally (legacy
array ordering / minimal legacy area records) and stay on Blob — surfaced as
drift on the diagnostics page, not hidden.

## Not in J6

Phil/worker/mobile reads, offline/service-worker, dual-write, per-job
`data.json`/stats reads (tags/itps/plans/snags have no PG home), production flag
enable. Next rung: J7 (Phil read cutover) — only after this is observed healthy.

---

# J7 — Phil (field) jobs read cutover (dark flag)

J7 extends the **same** parity-gated Blob-spine overlay to the **field/Phil**
audience. Phil's job list (`/phil/jobs`), My Day assigned jobs (`/phil/my-day`)
and job-detail **structure** (`/phil/jobs/[jobId]`) all funnel through the same
`/api/jobs` endpoint J6 covers — so J7 is the same seam, gated for field/
leading-hand roles behind a **separate** flag.

- **Flag:** `supabase_read_phil_jobs` (default OFF, unset in prod). Admin keeps
  `supabase_read_jobs`; the two cut over independently.
- **Same engine, one core.** `runJobsOverlay(flagKey, input, opts)` is shared by
  `readAdminJobsWithPgOverlay` (J6) and `readPhilJobsWithPgOverlay` (J7). Blob
  authoritative, per-job parity gate, automatic Blob fallback on any error —
  identical to J6.
- **Visible-scoped (no cross-worker leakage).** The Phil overlay is scoped to the
  worker's **visible** jobs (their assigned, non-draft/archived jobs — the exact
  set the list filter grants). PG is never read for jobs they can't see; non-
  visible jobs are returned untouched as Blob. The visibility filter that follows
  the seam is unchanged, so it remains the control on which jobs a worker sees.
- **Same safety contract:** flag off = exact current Blob behaviour; flag on =
  output semantically identical to Blob; drift → Blob; PG failure → Blob.

**Out of J7 (deferred):** task **STATUS** (the `dwellings` map: per-task
to-do/in-progress/done) is a *separate* read — `/api/data` →
`jobs/{id}/data.json` — which the jobs.json overlay does not touch. Cutting it
over (a second seam in `api/data.js`, careful not to affect the task-toggle
write-path read) is a later rung. Also out: clients (client portal), writes,
dual-write, offline, production flag enable.

## J7 diagnostics

The process-local counters (`api/_lib/job-read-diagnostics.js`) are split by
audience — `admin` (J6) and `phil` (J7). The `/jobs-read-status` page adds a
**Phil (field) read cutover** card showing the `supabase_read_phil_jobs` flag and
the phil-bucket counters (field reads served, from PG vs Blob, fallbacks, and the
last field read's visible PG-served/matched). There is no live Phil probe — the
overlay is per-worker-scoped and the admin page has no worker context.

## J7 dev validation (against the dev project, read-only)

Per real field/leading-hand worker: output semantically == Blob, no leakage of
non-visible jobs, plus flag OFF → Blob (DB untouched), PG outage → Blob fallback,
no-visible-jobs → Blob. On the dev dataset all 3 field workers' visible jobs are
representationally drifted (the same legacy ordering / minimal-area records as
J6), so 0 were PG-served — output Blob, safe, and the diagnostics report the 0/N
honestly. The PG-served path itself is proven by the unit tests (a faithful
visible job → served from Postgres).
