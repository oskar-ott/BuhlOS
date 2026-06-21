// Jobs STRUCTURE dual-write mirror (#152, J8) — best-effort, Blob-authoritative.
//
// Called from the jobs.json write paths (create / edit / bulk-edit / publish)
// AFTER the Blob write, which stays the source of truth. The PG mirror is
// best-effort: any failure is logged and SWALLOWED — it can never fail a job
// save. It mirrors ONE job's tenant/job/site_area_groups/site_areas/
// job_task_templates so the J6/J7 read overlays stop serving a frozen import
// snapshot and start being load-bearing. Drift is still caught by the structure
// sync-check (scripts/importers/structure-sync-check.js).
//
// Triple-gated so production is inert:
//   1. no SUPABASE_DB_URL in the runtime → return immediately (prod is unwired;
//      also keeps the write path free of the flag's blob read);
//   2. supabase_dual_write_jobs flag off (default/dark) → return;
//   3. getDb({mode:'write'}) runs the env guard → a non-prod env can only reach
//      the dev project; the prod project needs the explicit write opt-in.
//
// Row-building (buildStructureRows) + the upsert (writeAll) are the SAME code the
// bulk importer uses (scripts/importers/lib/{structure-rows,structure-writer}),
// so a live mirror and a bulk import can never diverge.
//
// SCOPE: structure only. Task INSTANCES + status (the `tasks` table, sourced from
// per-job data.json dwellings) are a SEPARATE rung — not mirrored here. A job
// hard-deleted from jobs.json is NOT mirrored: the read overlays are Blob-spine
// (existence is Blob-authoritative), so a stale Postgres-only job is never served.

const MIRROR_TIMEOUT_MS = 5000;

const { isFlagOn } = require('./feature-flags');
const { getDb } = require('./supabase-db');
const { withTimeout } = require('./hours-mirror');
const { buildStructureRows } = require('../../scripts/importers/lib/structure-rows');
const { writeAll } = require('../../scripts/importers/lib/structure-writer');

function realReadBlob(key, fallback) {
  return require('./blob').readBlob(key, fallback);
}

/**
 * Mirror ONE job's structure (create/edit) into Postgres. Best-effort — NEVER
 * throws. `deps` lets tests inject isFlagOn/getDb/readBlob/timeoutMs.
 * @returns {Promise<{mirrored:boolean, reason?:string, result?:object, error?:string}>}
 */
async function mirrorJobToPg(jobId, deps = {}) {
  const flagOn = deps.isFlagOn || isFlagOn;
  const db = deps.getDb || getDb;
  const readBlob = deps.readBlob || realReadBlob;
  try {
    if (!jobId) return { mirrored: false, reason: 'no jobId' };
    // Cheap prod short-circuit BEFORE the flag's blob read: prod has no SUPABASE_DB_URL.
    if (!process.env.SUPABASE_DB_URL) return { mirrored: false, reason: 'no supabase env' };
    if (!(await flagOn('supabase_dual_write_jobs'))) return { mirrored: false, reason: 'flag off' };
    return await withTimeout(mirrorJobWrite(db, readBlob, jobId), deps.timeoutMs || MIRROR_TIMEOUT_MS, 'mirrorJobToPg');
  } catch (err) {
    console.error('[jobs-mirror] best-effort PG mirror failed (Blob is authoritative):', err && err.message);
    return { mirrored: false, reason: 'error', error: err && err.message };
  }
}

async function mirrorJobWrite(db, readBlob, jobId) {
  // Re-read the authoritative Blob (read-after-write consistent on this instance)
  // so the mirror always reflects the just-saved state, whatever path wrote it.
  const data = await readBlob('jobs.json', { jobs: [] });
  const job = (data.jobs || []).find((j) => j && j.id === jobId);
  if (!job) {
    // Hard-deleted (or never existed) → nothing to mirror. A stale Postgres-only
    // job is never served by the Blob-spine read overlays, so this is safe.
    return { mirrored: false, reason: 'job not in blob' };
  }

  // Single-job sources: empty users (already imported; the job rows don't FK to
  // users in the importer) + just this one job.
  const sources = { users: { users: [] }, jobs: { jobs: [job] } };
  const nowIso = new Date().toISOString();
  const { tenantRow, userRows, jobRows, groupRows, areaRows, templateRows, quarantine } =
    buildStructureRows(sources, { nowIso });

  if (quarantine.length) {
    // The job is saved in Blob; its structure is malformed for PG (dup area id,
    // bad role, …) → skip the mirror (best-effort; the sync-check catches drift)
    // rather than throwing.
    console.warn(`[jobs-mirror] skipping job ${jobId} (Blob authoritative, sync-check will catch): ${quarantine[0].reason}`);
    return { mirrored: false, reason: 'quarantined', detail: quarantine[0].reason };
  }

  const sql = db({ mode: 'write' }); // env guard runs here; fail-closed
  const result = await writeAll(
    sql,
    { tenantRow, userRows, jobRows, groupRows, areaRows, templateRows },
    { counts: false },
  );
  return { mirrored: true, result };
}

module.exports = { mirrorJobToPg };
