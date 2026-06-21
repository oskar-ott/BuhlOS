// J10 — Phil task-status READ cutover (#152). DARK, parity-gated, Blob-authoritative.
//
// At the /api/data read seam, for the FIELD/Phil audience, when
// supabase_read_phil_tasks is ON, the per-job task STATUSES are confirmed against
// the Postgres mirror and served from PG ONLY when PG is byte-faithful to Blob for
// the whole job; otherwise the read falls back to Blob. Output is therefore
// provably identical to Blob — a worker can never lose task visibility or see a
// stale status because PG is behind (a not-yet-mirrored toggle simply fails parity
// → Blob fallback). This mirrors the J6/J7 read overlay, applied to task status.
//
// Reuses the ONE expansion engine (buildTaskProjection) and the existing
// (jobId,areaId,stage,taskId)→tasks.id bridge — NO new task identity. Read-only:
// getDb({mode:'read'}); never writes Blob or Postgres; never throws (best-effort →
// Blob). Worker isolation is the caller's requireAuth({jobId}) gate (unchanged) —
// this overlay only ever touches the single requested job.

const crypto = require('node:crypto');
const { isFlagOn } = require('./feature-flags');
const { getDb } = require('./supabase-db');
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
 * Parity-gated PG task-status read for ONE job. Returns { data, diag }. The data
 * is byte-identical to Blob; on a clean parity PASS the existing dwelling task
 * statuses are sourced from PG (== Blob). Best-effort — never throws. Injectable deps.
 */
async function readPhilTaskStatus(input = {}) {
  const { jobId, data, getDb: db = getDb, isFlagOn: flagOn = isFlagOn, readBlob = realReadBlob, tenantSlug = 'buhl', now = Date.now } = input;
  const started = now();
  const elapsed = () => Math.max(0, now() - started);

  if (!process.env.SUPABASE_DB_URL) return { data, diag: BLOB_DIAG('no supabase env', elapsed(), false) };
  let flagIsOn = false;
  try {
    flagIsOn = (await flagOn('supabase_read_phil_tasks')) === true;
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
    const tenant = await sql`select id from public.tenants where slug = ${tenantSlug}`;
    if (!tenant.length) return { data, diag: { ...BLOB_DIAG('no tenant', elapsed(), true), fallbackUsed: true } };
    const tenantId = tenant[0].id;
    const jobUuid = (await sql`select id from public.jobs where tenant_id = ${tenantId} and legacy_id = ${jobId} and deleted_at is null`)[0];
    if (!jobUuid) return { data, diag: { ...BLOB_DIAG('job not in pg', elapsed(), true), fallbackUsed: true } };
    const areaMap = await legacyIdMap(sql, 'site_areas', tenantId);

    const pgRows = await sql`
      select site_area_id, stage, legacy_template_id, status
      from public.tasks
      where tenant_id = ${tenantId} and job_id = ${jobUuid.id} and deleted_at is null
        and site_area_id is not null and legacy_template_id is not null`;
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

module.exports = { readPhilTaskStatus };
