// ADMIN single-job Postgres DIRECT read (#152) — perf for the /v2/jobs/[jobId]
// hub. DARK, freshness+parity-gated, Blob-authoritative.
//
// GET /api/jobs?id=<id> (the admin single-job read behind the job hub) had to
// fetch + parse the ENTIRE jobs.json monolith (~2.5s cold) to return ONE job.
// The J6 overlay (job-read-projection.js) doesn't help: it overlays PG on top of
// the full Blob read, so the monolith fetch remains. This module is the first
// admin read that SKIPS the monolith entirely: the job's migrated structure
// (areaGroups / roughInTasks / fitOffTasks + the migrated scalars) is
// reconstructed from the Postgres mirror that supabase_dual_write_jobs
// maintains, scoped to that ONE job.
//
// Postgres does NOT hold everything admin sees — money (contractValue,
// claimedToDate, …), customFields, scopeOfWork, clientUserId, modules content
// and createdAt are Blob-only (the importer defers them; see
// scripts/importers/lib/structure-rows.js). So the read is a two-source merge:
//   * PG        → the MIGRATED_JOB_FIELDS (the heavy structure — the reason the
//                 monolith read was slow),
//   * a tiny derived per-job blob `jobs/<id>/admin-extras.json` → everything
//                 else (the Blob-only remainder, built from the authoritative
//                 monolith on the full-read path, a few hundred bytes).
// As more fields migrate to PG the extras record shrinks — this is a genuine
// migration rung, not a cache of the whole job (that is what the field-only
// jobs/<id>/field-detail.json is; this is its PG-backed admin sibling).
//
// SAFETY CONTRACT (same as job-detail-projection.js / the J6 overlay):
//   * Blob authoritative. The fast path serves ONLY when BOTH gates pass:
//       1. FRESHNESS — extras.builtFromUploadedAt equals jobs.json's CURRENT
//          blob uploadedAt (metadata-only list(), no content fetch). Every
//          jobs.json writer advances uploadedAt, so ANY write — this job or
//          another, structure or money — invalidates the extras and the read
//          falls back to the full monolith read (which rebuilds them). The
//          accepted staleness window is therefore the Blob metadata API's own
//          read-after-write consistency — the SAME trust the shipped
//          jobs-summary / field-detail projections already place in it; there
//          is no window in which an edited job is served from the fast path.
//       2. PARITY — sha256 over the PG job's migrated fields (the J6
//          migratedFieldsHash, key-order-normalised) equals the hash of the
//          Blob job stamped into the extras at build time. A lagging or failed
//          dual-write mirror (it is best-effort) can therefore never serve
//          stale structure: PG drift → hash mismatch → full Blob read.
//     Merged output == the Blob job: identical top-level key set AND order
//     (the extras record stores keyOrder), values byte-identical for extras
//     fields and hash-identical for PG fields (nested key ORDER inside the PG
//     structure may differ — the same property the served J6 overlay already
//     accepts; no consumer depends on it).
//   * Always falls back — flag off / extras miss / stale / job absent in PG /
//     hash mismatch / ANY error → { job: null } and the caller runs the
//     authoritative full jobs.json read. Correctness is never sacrificed.
//   * MONEY: the extras record carries the commercial fields (it must — PG
//     doesn't), so the key + the read path are ADMIN-ONLY: the call site
//     (api/jobs.js) gates on isAdminRole BEFORE calling this, and the response
//     still passes through the SAME redactJobForViewer boundary as the full
//     read (a no-op for admin — exactly like jobs.json itself). The field
//     single-job path keeps its own money-stripped field-detail.json.
//   * No write-path change. Extras are rebuilt lazily by the FULL-read
//     fallback (which already holds the monolith), never by the fast path —
//     the fast path is read-only and never touches jobs.json.
//
// The extras key lives under the `jobs/` per-job blob namespace, already
// covered by the backup-manifest PREFIX_STORES — no manifest change needed.

const {
  reconstructFromPg,
  MIGRATED_JOB_FIELDS,
  migratedFieldsHash,
  deepCanonOrdered,
} = require('./job-read-projection');

const FLAG_KEY = 'supabase_read_job_detail';
const SOURCE_KEY = 'jobs.json';
const MIGRATED_SET = new Set(MIGRATED_JOB_FIELDS);

/** Per-job admin extras blob key (under the manifest-covered `jobs/` prefix). */
function adminExtrasKey(jobId) {
  return `jobs/${jobId}/admin-extras.json`;
}

/**
 * Pure: a full Blob job → the extras record the fast path merges with PG.
 *   keyOrder     — the job's top-level keys in Blob order (so the merged object
 *                  reproduces the Blob key set + order exactly),
 *   extras       — every non-migrated field verbatim (money, customFields,
 *                  scopeOfWork, modules, clientUserId, createdAt, …), so an
 *                  unknown/new Blob field can never be silently dropped,
 *   migratedHash — the J6 hash of the job's migrated fields, the parity gate a
 *                  later PG read must match before it may serve.
 */
function buildAdminExtrasRecord(job) {
  const keyOrder = Object.keys(job);
  const extras = {};
  for (const k of keyOrder) {
    if (!MIGRATED_SET.has(k)) extras[k] = job[k];
  }
  return { keyOrder, extras, migratedHash: migratedFieldsHash(job) };
}

/**
 * Pure: extras record + hash-verified PG job → the merged job. Iterates the
 * Blob keyOrder so the output's key SET and ORDER equal the Blob job's;
 * migrated keys take the PG value (hash-equal to Blob — PG is load-bearing),
 * everything else the stored Blob value. A PG undefined for a key the Blob had
 * becomes null — canonically what the hash already proved the Blob held.
 */
function mergeAdminJobDetail(record, pgJob) {
  const out = {};
  for (const k of record.keyOrder) {
    if (MIGRATED_SET.has(k)) {
      out[k] = pgJob[k] === undefined ? null : pgJob[k];
    } else if (Object.prototype.hasOwnProperty.call(record.extras, k)) {
      out[k] = record.extras[k];
    }
  }
  return out;
}

function isValidExtrasRecord(stored) {
  return !!(
    stored &&
    typeof stored === 'object' &&
    typeof stored.builtFromUploadedAt === 'string' &&
    stored.record &&
    typeof stored.record === 'object' &&
    Array.isArray(stored.record.keyOrder) &&
    stored.record.keyOrder.every((k) => typeof k === 'string') &&
    stored.record.extras &&
    typeof stored.record.extras === 'object' &&
    typeof stored.record.migratedHash === 'string'
  );
}

// The SAME six-table graph the J5/J6 list reconstruction queries
// (job-read-projection.js loadJobStructureFromPg), scoped to ONE job by
// legacy_id and WITHOUT the tasks/evidence legs — the admin single-job GET
// serves jobs.json content only (task status + evidence live on data.json and
// are read separately by the withStats enrichment). Same ORDER BY → the same
// deterministic reconstruction the hash gate relies on.
async function loadOneJobStructureFromPg(sql, tenantId, jobId) {
  const [jobs, groups, areas, templates] = await Promise.all([
    sql`
    select legacy_id, name, status, ref, job_type_label, external_ref, site_address,
           site_contact_name, site_contact_phone, access_notes, parking_notes, safety_notes,
           induction_required, start_date::text as start_date, due_date::text as due_date,
           programmed_duration_days, created_at::text as created_at
    from public.jobs
    where tenant_id = ${tenantId} and legacy_id = ${jobId} and deleted_at is null
    order by legacy_id`,
    sql`
    select g.legacy_id, jb.legacy_id as job_legacy, g.name, g.sort_order, (g.deleted_at is not null) as archived
    from public.site_area_groups g join public.jobs jb on jb.id = g.job_id
    where g.tenant_id = ${tenantId} and jb.legacy_id = ${jobId} and jb.deleted_at is null and g.legacy_id is not null
    order by g.sort_order, g.legacy_id`,
    sql`
    select a.legacy_id, jb.legacy_id as job_legacy, gp.legacy_id as group_legacy, a.name, a.space_type,
           a.sort_order, (a.deleted_at is not null) as archived
    from public.site_areas a join public.jobs jb on jb.id = a.job_id
    left join public.site_area_groups gp on gp.id = a.group_id
    where a.tenant_id = ${tenantId} and jb.legacy_id = ${jobId} and jb.deleted_at is null and a.legacy_id is not null
    order by a.sort_order, a.legacy_id`,
    sql`
    select t.legacy_id, jb.legacy_id as job_legacy, ar.legacy_id as area_legacy, t.stage, t.name,
           t.sort_order, (t.deleted_at is not null) as archived
    from public.job_task_templates t join public.jobs jb on jb.id = t.job_id
    left join public.site_areas ar on ar.id = t.site_area_id
    where t.tenant_id = ${tenantId} and jb.legacy_id = ${jobId} and jb.deleted_at is null and t.legacy_id is not null
    order by t.sort_order, t.legacy_id`,
  ]);
  const { jobs: jobsDoc } = reconstructFromPg({
    jobs: [...jobs], groups: [...groups], areas: [...areas], templates: [...templates],
  });
  return jobsDoc.jobs.length ? jobsDoc.jobs[0] : null;
}

function realDeps() {
  const blob = require('./blob');
  return {
    readBlob: blob.readBlob,
    writeBlob: blob.writeBlob,
    blobUploadedAt: blob.blobUploadedAt,
    getDb: (opts) => require('./supabase-db').getDb(opts),
    isFlagOn: (key) => require('./feature-flags').isFlagOn(key),
  };
}

const BLOB_DIAG = (reason, latencyMs, flagOn) => ({
  source: 'blob', reason, flagOn: flagOn === true, parityPass: null,
  uploadedAt: null, rebuildExtras: false, latencyMs, fallbackUsed: false, error: null,
});

/**
 * The ADMIN single-job PG fast read. Returns { job, diag }:
 *   - job: the merged job (== the Blob job) when BOTH the freshness gate and
 *     the parity gate pass, else null (caller runs the full jobs.json read).
 *   - diag.rebuildExtras + diag.uploadedAt tell the fallback path to rebuild
 *     the extras record (best-effort) so the NEXT read takes the fast path.
 * NEVER throws and NEVER reads jobs.json content. Injectable deps for tests.
 * The audience gate (admin-tier only) is the CALLER's job — api/jobs.js checks
 * isAdminRole before calling; this module pins the flag so it can't be spoofed.
 */
async function readAdminJobDetailFromPg(jobId, deps = {}) {
  const d = { ...realDeps(), ...deps };
  const { readBlob, blobUploadedAt, getDb, isFlagOn, tenantSlug = 'buhl', now = Date.now } = d;
  const started = now();
  const elapsed = () => Math.max(0, now() - started);
  const miss = (reason, over = {}) => ({
    job: null,
    diag: { ...BLOB_DIAG(reason, elapsed(), true), ...over },
  });

  if (!jobId) return miss('no jobId', { flagOn: false });
  if (!process.env.SUPABASE_DB_URL) return miss('no supabase env', { flagOn: false });
  let flagOn = false;
  try {
    flagOn = (await isFlagOn(FLAG_KEY)) === true;
    if (!flagOn) return miss('flag off', { flagOn: false });

    // Freshness leg first (cheap, both calls in parallel): uploadedAt is a
    // metadata-only list(); the extras blob is a few hundred bytes.
    const [uploadedAt, stored] = await Promise.all([
      blobUploadedAt(SOURCE_KEY),
      readBlob(adminExtrasKey(jobId), null).catch(() => null),
    ]);
    // Can't confirm the source's current version → NEVER serve; also don't ask
    // the fallback to stamp a rebuild it couldn't validate later.
    if (uploadedAt == null) return miss('no uploadedAt');
    if (!isValidExtrasRecord(stored)) return miss('extras miss', { uploadedAt, rebuildExtras: true });
    if (stored.builtFromUploadedAt !== uploadedAt) return miss('extras stale', { uploadedAt, rebuildExtras: true });

    // Extras are fresh — now the PG structure leg + the parity gate.
    const sql = getDb({ mode: 'read' }); // read-only; never a write
    const tenant = await sql`select id from public.tenants where slug = ${tenantSlug}`;
    if (!tenant.length) return miss('no tenant', { uploadedAt, fallbackUsed: true });
    const pgJob = await loadOneJobStructureFromPg(sql, tenant[0].id, jobId);
    if (!pgJob) return miss('job not in pg', { uploadedAt, fallbackUsed: true });
    if (migratedFieldsHash(pgJob) !== stored.record.migratedHash) {
      // PG lags Blob (best-effort mirror) or drifted → Blob, never stale.
      return miss('pg parity mismatch → blob', { uploadedAt, parityPass: false, fallbackUsed: true });
    }

    return {
      job: mergeAdminJobDetail(stored.record, pgJob),
      diag: {
        source: 'postgres', reason: 'served from postgres', flagOn: true,
        parityPass: true, uploadedAt, rebuildExtras: false,
        latencyMs: elapsed(), fallbackUsed: false, error: null,
      },
    };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn('[job-detail-pg] PG single-job read failed (Blob authoritative):', msg);
    return miss('error', { flagOn, fallbackUsed: flagOn === true, error: msg });
  }
}

/**
 * Best-effort extras (re)build, called by the FULL-read fallback in api/jobs.js
 * with the job it just read from the authoritative monolith. `uploadedAt` MUST
 * be the jobs.json uploadedAt sampled BEFORE that monolith read (the fast-path
 * attempt supplies it via diag.uploadedAt): if a write lands between the sample
 * and the content read, the stamp predates the content, so the next fast read
 * sees a newer uploadedAt, treats the extras as stale and rebuilds — the race
 * degrades to an extra fallback, never to serving stale data. Never throws.
 */
async function persistAdminExtras(jobId, job, uploadedAt, deps = {}) {
  if (!jobId || !job || typeof uploadedAt !== 'string') return { persisted: false };
  const { writeBlob = realDeps().writeBlob } = deps;
  try {
    await writeBlob(adminExtrasKey(jobId), {
      builtFromUploadedAt: uploadedAt,
      record: buildAdminExtrasRecord(job),
    });
    return { persisted: true };
  } catch (err) {
    console.warn('[job-detail-pg] extras persist failed (best-effort):', err && err.message);
    return { persisted: false };
  }
}

// Live parity probe — bounded sample so the diagnostics page stays cheap
// (each job costs the four single-job PG queries).
const PROBE_SAMPLE_LIMIT = 10;

/**
 * Read-only parity probe for the /jobs-read-status page: proves, per sampled
 * job, that extras-build → PG reconstruct → merge reproduces the Blob job —
 * BEFORE the flag is ever flipped (it ignores the flag; nothing is served,
 * nothing persisted). Classifies each job:
 *   faithful    — hash gate passes AND the merged job deep-equals the Blob job
 *                 (canonical compare; byteEqual additionally counts strict
 *                 JSON.stringify equality — the nested-key-order caveat),
 *   drifted     — migrated-fields hash mismatch (PG lags/diverges → the served
 *                 path would fall back),
 *   mergeDrift  — hash passed but the merge didn't reproduce the job (would
 *                 indicate a merge bug; must stay 0),
 *   unavailable — job not in PG (not yet mirrored),
 *   errored     — PG unreachable for that job.
 * Counts + booleans only; no job content leaves the probe. Never throws.
 */
async function probeAdminJobDetailParity(deps = {}) {
  const d = { ...realDeps(), ...deps };
  const { readBlob, getDb, tenantSlug = 'buhl', now = Date.now, sampleLimit = PROBE_SAMPLE_LIMIT } = d;
  const started = now();
  const elapsed = () => Math.max(0, now() - started);
  const empty = (over = {}) => ({
    wired: true, jobsTotal: 0, jobsSampled: 0,
    faithful: 0, byteEqual: 0, drifted: 0, mergeDrift: 0, unavailable: 0, errored: 0,
    latencyMs: elapsed(), error: null, ...over,
  });

  if (!process.env.SUPABASE_DB_URL) return empty({ wired: false });
  try {
    const jobsBlob = await readBlob(SOURCE_KEY, { jobs: [] });
    const allJobs = (jobsBlob.jobs || []).filter((j) => j && j.id);
    const sample = allJobs.slice(0, Math.max(0, sampleLimit));
    const agg = { faithful: 0, byteEqual: 0, drifted: 0, mergeDrift: 0, unavailable: 0, errored: 0 };
    const sql = getDb({ mode: 'read' });
    const tenant = await sql`select id from public.tenants where slug = ${tenantSlug}`;
    if (!tenant.length) return empty({ jobsTotal: allJobs.length, error: 'no tenant' });
    for (const job of sample) {
      try {
        const record = buildAdminExtrasRecord(job);
        const pgJob = await loadOneJobStructureFromPg(sql, tenant[0].id, job.id);
        if (!pgJob) { agg.unavailable += 1; continue; }
        if (migratedFieldsHash(pgJob) !== record.migratedHash) { agg.drifted += 1; continue; }
        const merged = mergeAdminJobDetail(record, pgJob);
        const canonEqual =
          JSON.stringify(deepCanonOrdered(merged)) === JSON.stringify(deepCanonOrdered(job));
        if (!canonEqual) { agg.mergeDrift += 1; continue; }
        agg.faithful += 1;
        if (JSON.stringify(merged) === JSON.stringify(job)) agg.byteEqual += 1;
      } catch {
        agg.errored += 1;
      }
    }
    return empty({ jobsTotal: allJobs.length, jobsSampled: sample.length, ...agg });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn('[job-detail-pg] parity probe failed (best-effort):', msg);
    return empty({ error: msg });
  }
}

module.exports = {
  FLAG_KEY,
  adminExtrasKey,
  buildAdminExtrasRecord,
  mergeAdminJobDetail,
  loadOneJobStructureFromPg,
  readAdminJobDetailFromPg,
  persistAdminExtras,
  probeAdminJobDetailParity,
};
