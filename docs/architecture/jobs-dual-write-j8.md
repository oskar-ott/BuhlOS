# J8 — Jobs structure dual-write mirror (dark flag)

Part of the Blob→Postgres migration (#152). J5/J6/J7 made the jobs read
*reconstructable* and *served* from Postgres, but Postgres was a **frozen import
snapshot** — so most jobs read-drifted and fell back to Blob. J8 is the first
*write* slice for jobs: it keeps Postgres in step with Blob so the J6/J7 read
overlays become **load-bearing** instead of always falling back.

## What it does

When a jobs.json **structure** write happens (create / edit / bulk-edit /
duplicate / publish), the affected job's `tenant → job → site_area_groups →
site_areas → job_task_templates` rows are **mirrored into Postgres**, best-effort,
**after** the Blob write. It is the exact pattern of the hours dual-write
(`api/_lib/hours-mirror.js`).

- **Blob stays authoritative.** The mirror runs after the Blob write; any failure
  is logged and swallowed — it can never fail a job save. Drift is still caught by
  the structure sync-check.
- **Same code as the bulk importer.** Row-building (`buildStructureRows`) and the
  upsert (`writeAll`, extracted to `scripts/importers/lib/structure-writer.js` and
  now shared by the importer AND the mirror) are identical, so a live mirror and a
  bulk import can never diverge. Upserts are idempotent (`IS DISTINCT FROM` → an
  unchanged re-run writes 0 rows; archive-aware `deleted_at` never churns).
- **Triple-gated so production is inert:** (1) no `SUPABASE_DB_URL` → return
  before anything; (2) `supabase_dual_write_jobs` flag off (default/dark) →
  return; (3) `getDb({mode:'write'})` runs the env guard (a non-prod runtime can
  only reach the dev project; prod needs the explicit write opt-in). Bounded by a
  5s timeout so a slow pooler can't hang a save.

## Wired write paths

`mirrorJobToPg(jobId)` is called after the Blob write in: `createJob`
(`api/_lib/job-create.js` — POST + quote-convert), `api/jobs.js` PUT (edit) and
POST `?action=duplicate`, `api/jobs-bulk-edit.js`, and `api/job-draft.js`
(publish). The mirror **re-reads** the authoritative Blob by `jobId` (read-after-
write consistent on the instance), so it always mirrors the just-saved state
whatever path wrote it.

Not yet wired (safe to defer — a missing site just means that edit doesn't
immediately mirror, so the read overlay falls back to Blob for that job):
`job-templates.js`, `job-circuits.js`, `cash-watch.js`, `users.js`. These touch
narrower or non-migrated fields.

## Scope / honest limitations

- **Structure only.** The J6/J7 read overlays read jobs.json structure
  (job/groups/areas/templates), so that is exactly what is mirrored. Task
  INSTANCES + status (the `tasks` table, sourced from per-job `data.json`
  dwellings via task-toggle) are a **separate rung**, paired with the deferred
  task-status read.
- **Upsert-only (no hard-delete reconciliation).** Like the importer, the mirror
  upserts the job's current areas/groups/templates and is archive-aware
  (`archived:true` → `deleted_at`). It does **not** hard-delete PG rows for areas
  removed from Blob without being archived. In BuhlOS archive is the universal
  "remove", so this covers normal edits; a true hard-removal would leave a stale
  PG row — harmless, because the Blob-spine read overlays never serve a
  Postgres-only entity.
- **Hard-deleted jobs are not mirrored.** A job removed from jobs.json (test-job
  cleanup) leaves its PG rows stale, never served (Blob is the existence spine).
- **On the request path.** The mirror is awaited (bounded by the timeout), adding
  a few round-trips per structural save when the flag is on. Moving it off the
  request path (waitUntil / an outbox) is a later rung.

## Dev validation (against the dev project)

Idempotent (2nd mirror run writes 0 rows); a real name change **lands in Postgres
then reverts**; flag OFF → skip (DB untouched); PG down → best-effort skip (no
throw); unknown/hard-deleted job → skip. Structure sync-check **IN SYNC** after
(240==240, hashes equal) — the validation left dev Postgres uncorrupted.

## Not in J8

Task-instance/status dual-write (the `tasks` table + task-toggle), production flag
enable, off-request-path delivery, hard-delete reconciliation, the narrower
write sites above.
