// Jobs mirror RECONCILE sweep (#152 follow-up) — self-healing for the one-shot
// write-through mirror.
//
// mirrorJobToPg (api/_lib/jobs-mirror.js) fires ONCE per job save and is
// deliberately best-effort: a transient PG failure at create time is swallowed,
// and if the job is never re-saved the hole persists forever. Prod proof:
// DCA Alexandria (created 2026-07-14) was absent from public.jobs for twelve
// days, which quarantined every hours allocation logged against it (the
// blank-week bug #909 gated around). This sweep closes that seam: compare the
// authoritative jobs.json id set against public.jobs.legacy_id and re-run the
// NORMAL mirror for anything missing — same rows, same upsert, same gates as
// the write path, so a swept job and a live-mirrored job can never diverge.
//
// ADD-ONLY: a job present in PG but absent from Blob (hard-deleted) is left
// alone — the read overlays are Blob-spine, so a stale PG row is never served
// (see jobs-mirror.js SCOPE note).
//
// Triple-gated exactly like the write path (env → flag → getDb guard), so it
// skips cleanly wherever the mirror itself is dark. Best-effort: never throws;
// a failed re-mirror is recorded via recordMirrorDrift (DWD-04) so the failure
// is visible on the error journal instead of silent.

const { isFlagOn } = require('./feature-flags');
const { getDb } = require('./supabase-db');
const { mirrorJobToPg } = require('./jobs-mirror');
const { recordMirrorDrift } = require('./mirror-drift');

function realReadBlob(key, fallback) {
  return require('./blob').readBlob(key, fallback);
}

/**
 * Re-mirror every job that exists in Blob jobs.json but not in public.jobs.
 * Best-effort — NEVER throws. `deps` lets tests inject
 * isFlagOn/getDb/readBlob/mirrorJobToPg/recordDrift/env.
 *
 * @returns {Promise<{ran:boolean, reason?:string, error?:string,
 *   checked?:number, missing?:number, remirrored?:number, failed?:number,
 *   failures?:Array<{jobId:string, reason?:string, error?:string}>}>}
 */
async function reconcileJobsMirror(deps = {}) {
  const flagOn = deps.isFlagOn || isFlagOn;
  const db = deps.getDb || getDb;
  const readBlob = deps.readBlob || realReadBlob;
  const mirror = deps.mirrorJobToPg || mirrorJobToPg;
  const recordDrift = deps.recordDrift || recordMirrorDrift;
  const env = deps.env || process.env;
  try {
    // Cheap short-circuit BEFORE the flag's blob read, same order as the
    // write path: an unwired env must cost nothing.
    if (!env.SUPABASE_DB_URL) return { ran: false, reason: 'no supabase env' };
    if (!(await flagOn('supabase_dual_write_jobs'))) return { ran: false, reason: 'flag off' };

    const jobsBlob = await readBlob('jobs.json', { jobs: [] });
    const blobIds = (jobsBlob.jobs || []).map((j) => j && j.id).filter(Boolean);
    if (blobIds.length === 0) {
      return { ran: true, checked: 0, missing: 0, remirrored: 0, failed: 0 };
    }

    const sql = db({ mode: 'read' });
    const rows = await sql`select legacy_id from public.jobs where legacy_id is not null`;
    const inPg = new Set(rows.map((r) => r.legacy_id));
    const missing = blobIds.filter((id) => !inPg.has(id));

    let remirrored = 0;
    const failures = [];
    for (const jobId of missing) {
      // mirrorJobToPg is itself best-effort + gated; a per-job failure never
      // stops the sweep of the remaining jobs.
      const result = await mirror(jobId);
      if (result && result.mirrored) {
        remirrored++;
      } else {
        failures.push({ jobId, reason: result && result.reason, error: result && result.error });
        // DWD-04: Blob has the job, PG still doesn't — that is drift; make it
        // visible. recordMirrorDrift only captures on reason:'error'.
        await recordDrift({ domain: 'jobs', result, jobId, key: 'jobs.json' });
      }
    }

    return {
      ran: true,
      checked: blobIds.length,
      missing: missing.length,
      remirrored,
      failed: failures.length,
      ...(failures.length ? { failures } : {}),
    };
  } catch (err) {
    console.error('[jobs-reconcile] best-effort sweep failed (Blob is authoritative):', err && err.message);
    return { ran: false, reason: 'error', error: err && err.message };
  }
}

module.exports = { reconcileJobsMirror };
