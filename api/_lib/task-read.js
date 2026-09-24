// J10/J11 — task-status READ cutover (#152). DARK, parity-gated, Blob-authoritative.
//
// At the /api/data read seam, the per-job task STATUSES are confirmed against the
// Postgres mirror and served from PG ONLY when PG is byte-faithful to Blob for the
// whole job; otherwise the read falls back to Blob. Output is therefore provably
// identical to Blob — a reader can never lose task visibility or see a stale status
// because PG is behind (a not-yet-mirrored toggle simply fails parity → Blob
// fallback). This mirrors the J6/J7 read overlay, applied to task status.
//
// ONE parity engine (readTaskStatusOverlay — INTERNAL, not exported), two
// audience wrappers that differ ONLY by feature flag:
//   * readPhilTaskStatus  — FIELD/Phil read (supabase_read_phil_tasks, J10)
//   * readAdminTaskStatus — ADMIN/office read (supabase_read_admin_tasks, J11)
// The audience gate (which tier hits which wrapper, and clients always reading
// pure Blob) lives at the call site (api/data.js); this module is audience-blind.
//
// J12 — cutover READINESS (no behaviour change, no new flag): probeTaskReadParity
// runs the SAME engine read-only across a bounded sample of jobs (flag forced on,
// nothing served) to measure how byte-faithful the PG mirror is to Blob across the
// job population — the evidence a later served-source promotion (J13) is gated on.
// Blob stays authoritative; PG is not the source of truth yet.
//
// Reuses the ONE expansion engine (buildTaskProjection) and the existing
// (jobId,areaId,stage,taskId)→tasks.id bridge — NO new task identity. Read-only:
// getDb({mode:'read'}); never writes Blob or Postgres; never throws (best-effort →
// Blob). Reader isolation is the caller's requireAuth({jobId}) gate (unchanged) —
// this overlay only ever touches the single requested job.
//
// SINGLE-TENANT: tenantSlug defaults to 'buhl' (the only tenant; a documented
// rebuild non-negotiable). It is injectable for tests but never overridden in
// production; a second tenant would simply miss the PG lookup and fall back to
// Blob (safe, never a cross-tenant leak).

const crypto = require('node:crypto');
const { isFlagOn } = require('./feature-flags');
const { getDb } = require('./supabase-db');
const { defaultPgReadCache } = require('./pg-read-cache');
const { buildTaskProjection } = require('../../scripts/importers/lib/task-projection');
const { decomposeLegacyId } = require('../../scripts/importers/lib/structure-legacy-id');

function realReadBlob(key, fallback) {
  return require('./blob').readBlob(key, fallback);
}
async function legacyIdMap(sql, table, tenantId) {
  const rows = await sql`select id, legacy_id from ${sql(table)} where tenant_id = ${tenantId} and legacy_id is not null`;
  return new Map(rows.map((r) => [r.legacy_id, r.id]));
}
// sha256 over sorted "canonicalKey=status" tuples — order-independent.
function statusHash(pairs) {
  return crypto.createHash('sha256').update(pairs.slice().sort().join('|')).digest('hex');
}
const BLOB_DIAG = (reason, latencyMs, flagOn) => ({
  source: 'blob', reason, flagOn: flagOn === true, parityPass: null,
  matched: 0, mismatched: 0, orphans: 0, duplicates: 0, unresolved: 0,
  hashMatch: null, latencyMs, fallbackUsed: false, error: null,
});

/**
 * @internal — NOT exported. Direct callers MUST use `readPhilTaskStatus` or
 * `readAdminTaskStatus` (or `probeTaskReadParity`), which pin the audience flag
 * so the tier can never be spoofed via a caller-supplied `flagKey`. Exposing the
 * raw engine would let a caller serve PG under an unapproved flag.
 *
 * Parity-gated PG task-status read for ONE job, behind `flagKey`. Returns
 * { data, diag }. The data is byte-identical to Blob; on a clean parity PASS the
 * existing dwelling task statuses are sourced from PG (== Blob). Best-effort —
 * never throws. Injectable deps. Audience-blind: the wrappers pin the flag; the
 * caller (api/data.js) owns which tier reaches which wrapper.
 */
async function readTaskStatusOverlay(input = {}) {
  const { jobId, data, flagKey = 'supabase_read_phil_tasks', getDb: db = getDb, isFlagOn: flagOn = isFlagOn, readBlob = realReadBlob, tenantSlug = 'buhl', now = Date.now } = input;
  // Perf: tenant id + the per-job PG task-state read are process-cached (see
  // ./pg-read-cache.js — the parity gate below re-checks against THIS request's
  // fresh Blob projection, so a stale mirror can only fall back to Blob, never
  // serve wrong statuses). Cache defaults OFF whenever the caller injects
  // `getDb` (unit tests, the J12 probe) unless it passes its own `pgCache`.
  const pgCache = Object.prototype.hasOwnProperty.call(input, 'pgCache')
    ? input.pgCache
    : (Object.prototype.hasOwnProperty.call(input, 'getDb') ? null : defaultPgReadCache);
  const started = now();
  const elapsed = () => Math.max(0, now() - started);

  if (!process.env.SUPABASE_DB_URL) return { data, diag: BLOB_DIAG('no supabase env', elapsed(), false) };
  let flagIsOn = false;
  try {
    flagIsOn = (await flagOn(flagKey)) === true;
    if (!flagIsOn) return { data, diag: BLOB_DIAG('flag off', elapsed(), false) };

    const jobsBlob = await readBlob('jobs.json', { jobs: [] });
    const job = (jobsBlob.jobs || []).find((j) => j && j.id === jobId);
    if (!job) return { data, diag: { ...BLOB_DIAG('job not in blob', elapsed(), true), fallbackUsed: true } };

    // Blob side: the ONE expansion engine → instances (canonical identity + status).
    const projection = buildTaskProjection({ jobs: { jobs: [job] }, jobData: { [jobId]: data } });
    if (!projection.clean) {
      return { data, diag: { ...BLOB_DIAG('projection not clean', elapsed(), true), fallbackUsed: true } };
    }

    const sql = db({ mode: 'read' }); // read cutover — never a write
    const tenantId = pgCache
      ? await pgCache.tenantId(sql, tenantSlug)
      : (await sql`select id from public.tenants where slug = ${tenantSlug}`)
          .map((r) => r.id)[0] ?? null;
    if (tenantId == null) return { data, diag: { ...BLOB_DIAG('no tenant', elapsed(), true), fallbackUsed: true } };

    // The per-job PG task state, as one memoisable read. Query ORDER inside is
    // unchanged from the pre-cache code (job uuid → area map → task rows) so
    // injected test fakes keep observing the same sequence. `null` (job not in
    // PG) is a legitimate cached value — a just-created Blob job simply keeps
    // its Blob fallback for the TTL.
    const fetchTaskState = async () => {
      const jobUuid = (await sql`select id from public.jobs where tenant_id = ${tenantId} and legacy_id = ${jobId} and deleted_at is null`)[0];
      if (!jobUuid) return null;
      const areaMap = await legacyIdMap(sql, 'site_areas', tenantId);
      const pgRows = await sql`
        select site_area_id, stage, legacy_template_id, status
        from public.tasks
        where tenant_id = ${tenantId} and job_id = ${jobUuid.id} and deleted_at is null
          and site_area_id is not null and legacy_template_id is not null`;
      return { areaMap, pgRows };
    };
    const taskState = pgCache
      ? await pgCache.memoize(`task-state:${tenantSlug}:${jobId}`, fetchTaskState)
      : await fetchTaskState();
    if (!taskState) return { data, diag: { ...BLOB_DIAG('job not in pg', elapsed(), true), fallbackUsed: true } };
    const { areaMap, pgRows } = taskState;
    const pgByKey = new Map(pgRows.map((r) => [`${r.site_area_id}|${r.stage}|${r.legacy_template_id}`, r.status]));

    // Per-task parity (whole-job gate): every blob instance must resolve to a PG
    // task with the SAME status; no orphan PG task; no unresolved instance.
    let matched = 0, mismatched = 0, unresolved = 0;
    const blobPairs = [], pgPairs = [];
    const matchedKeys = new Set();
    const overlay = []; // { areaId, stage, taskId, status } to source from PG on PASS
    for (const inst of projection.instances) {
      const sa = areaMap.get(inst.areaLegacy);
      if (!sa) { unresolved += 1; continue; }
      const key = `${sa}|${inst.stage}|${inst.legacyTemplateId}`;
      const canonical = `${inst.areaLegacy}|${inst.stage}|${inst.legacyTemplateId}`;
      blobPairs.push(`${canonical}=${inst.status}`);
      if (!pgByKey.has(key)) { unresolved += 1; continue; }
      matchedKeys.add(key);
      const pgStatus = pgByKey.get(key);
      pgPairs.push(`${canonical}=${pgStatus}`);
      if (pgStatus !== inst.status) { mismatched += 1; continue; }
      matched += 1;
      const d = decomposeLegacyId(inst.areaLegacy);
      overlay.push({ areaId: d ? d.localId : inst.areaLegacy, stage: inst.stage, taskId: inst.legacyTemplateId, status: pgStatus });
    }
    const orphans = pgRows.length - matchedKeys.size; // PG tasks with no matching blob instance
    const hashMatch = statusHash(blobPairs) === statusHash(pgPairs);
    const pass = mismatched === 0 && unresolved === 0 && orphans === 0 && hashMatch;

    if (!pass) {
      return { data, diag: { ...BLOB_DIAG('parity mismatch → blob', elapsed(), true), parityPass: false, matched, mismatched, orphans, unresolved, hashMatch, fallbackUsed: true } };
    }

    // PASS: source the EXISTING dwelling task statuses from PG (== Blob; never
    // adds a dwelling entry, so output stays byte-identical to Blob).
    const out = JSON.parse(JSON.stringify(data));
    for (const o of overlay) {
      const dw = out.dwellings && out.dwellings[o.areaId];
      const st = dw && dw[o.stage];
      if (st && st.tasks && Object.prototype.hasOwnProperty.call(st.tasks, o.taskId)) st.tasks[o.taskId] = o.status;
    }
    return { data: out, diag: { source: 'postgres', reason: 'served from postgres', flagOn: true, parityPass: true, matched, mismatched, orphans, unresolved, hashMatch: true, latencyMs: elapsed(), fallbackUsed: false, error: null } };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn('[task-read] PG task-status read failed (Blob authoritative):', msg);
    return { data, diag: { ...BLOB_DIAG('error', elapsed(), flagIsOn), fallbackUsed: flagIsOn === true, error: msg } };
  }
}

// Audience wrappers — identical parity engine, different flag. They keep the
// existing { jobId, data, ...injectable deps } signature; passing `flagKey` in
// `input` is ignored (the wrapper pins it), so the audience can never be spoofed
// by the caller.
function readPhilTaskStatus(input = {}) {
  return readTaskStatusOverlay({ ...input, flagKey: 'supabase_read_phil_tasks' });
}
function readAdminTaskStatus(input = {}) {
  return readTaskStatusOverlay({ ...input, flagKey: 'supabase_read_admin_tasks' });
}

// J12 — how many jobs the live readiness probe samples per call. Bounded so the
// probe stays cheap on the admin page (it reads one data.json + a few PG queries
// per job). The probe reports jobsTotal vs jobsSampled so any truncation is
// visible (no silent cap).
const PROBE_SAMPLE_LIMIT = 25;

/**
 * J12 cutover-READINESS probe. Read-only, best-effort, never throws. Runs the
 * SAME parity engine (flag forced ON, so it measures even while serving is dark)
 * across a bounded, deterministic sample of jobs and aggregates how byte-faithful
 * the PG mirror is to Blob. Nothing is served and nothing is written; this only
 * produces the evidence a served-source promotion (J13) would be gated on.
 *
 * Per sampled job it classifies the engine's own diag:
 *   - source==='postgres'      → pgFaithful (clean parity PASS, output == Blob)
 *   - parityPass===false       → drifted     (real divergence: mismatch/orphan/unresolved/hash)
 *   - reason==='error'         → errored     (PG unreachable for that job)
 *   - otherwise                → unavailable (not yet mirrored / job not in PG / projection unclean)
 *
 * Returns counts + booleans only — NO job ids, NO statuses, NO worker/user data.
 */
async function probeTaskReadParity(input = {}) {
  const { getDb: db = getDb, readBlob = realReadBlob, tenantSlug = 'buhl', now = Date.now, sampleLimit = PROBE_SAMPLE_LIMIT } = input;
  const started = now();
  const elapsed = () => Math.max(0, now() - started);
  const empty = (over = {}) => ({
    wired: true, jobsTotal: 0, jobsSampled: 0,
    pgFaithful: 0, drifted: 0, errored: 0, unavailable: 0,
    totalMismatched: 0, totalUnresolved: 0, totalOrphans: 0, hashDriftJobs: 0,
    latencyMs: elapsed(), error: null, ...over,
  });

  if (!process.env.SUPABASE_DB_URL) return empty({ wired: false });
  try {
    const jobsBlob = await readBlob('jobs.json', { jobs: [] });
    const allJobs = (jobsBlob.jobs || []).filter((j) => j && j.id);
    const sample = allJobs.slice(0, Math.max(0, sampleLimit));
    const agg = { pgFaithful: 0, drifted: 0, errored: 0, unavailable: 0, totalMismatched: 0, totalUnresolved: 0, totalOrphans: 0, hashDriftJobs: 0 };
    for (const job of sample) {
      const data = await readBlob(`jobs/${job.id}/data.json`, { dwellings: {}, snags: [], notes: [] });
      // Reuse the EXACT serving engine, flag forced ON → measure parity without
      // depending on (or changing) the real flag. Read-only; result is discarded.
      const { diag } = await readTaskStatusOverlay({
        jobId: job.id, data, flagKey: 'supabase_read_admin_tasks',
        isFlagOn: async () => true, getDb: db, readBlob, tenantSlug, now,
      });
      if (diag.source === 'postgres') { agg.pgFaithful += 1; }
      else if (diag.parityPass === false) {
        agg.drifted += 1;
        agg.totalMismatched += diag.mismatched || 0;
        agg.totalUnresolved += diag.unresolved || 0;
        agg.totalOrphans += diag.orphans || 0;
        if (diag.hashMatch === false) agg.hashDriftJobs += 1;
      } else if (diag.reason === 'error') { agg.errored += 1; }
      else { agg.unavailable += 1; }
    }
    return empty({ jobsTotal: allJobs.length, jobsSampled: sample.length, ...agg });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn('[task-read] readiness probe failed (best-effort):', msg);
    return empty({ error: msg });
  }
}

// readTaskStatusOverlay is INTENTIONALLY not exported — see its @internal note.
module.exports = { readPhilTaskStatus, readAdminTaskStatus, probeTaskReadParity };
