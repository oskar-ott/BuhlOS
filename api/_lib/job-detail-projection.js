// Phil FIELD single-job STRUCTURE projection (perf — Phil mobile job-detail LCP).
//
// /api/jobs?id=… (the single-job detail GET that backs /phil/jobs/[jobId]) had to
// fetch + parse the whole jobs.json monolith (~3.5s uncached) just to return ONE
// job's structure. This derives a small PER-JOB blob `jobs/<id>/field-detail.json`
// and serves the field/leading-hand single-job read from it.
//
// This is the structure-bearing sibling of api/_lib/jobs-summary.js (which does
// the same for the field LIST). Same safety contract:
//   * Blob authoritative — jobs.json is never replaced; the per-job projection is
//     a derived cache rebuilt from it.
//   * Never stale — every read validates the projection's `builtFromUploadedAt`
//     against jobs.json's CURRENT blob uploadedAt (a metadata-only list(), no
//     content fetch via blobUploadedAt); any mismatch/miss → rebuild from the
//     monolith. Every one of the 8+ jobs.json writers advances jobs.json's
//     uploadedAt, so any write invalidates every per-job projection automatically.
//   * Always falls back — a missing/corrupt projection, a job absent from the
//     monolith, or any error returns record:null (or the caller catches a throw)
//     and the caller falls back to the authoritative full jobs.json read.
//   * No write-path change — rebuilt lazily on read only.
//
// The stored record is the job MINUS the money fields (the adminTier audience in
// job-redaction.js — derived there so this can never drift from redaction), so a
// commercial figure can never sit in a field-served blob even on a redaction bug.
// EVERYTHING ELSE is kept verbatim — the full areaGroups/roughInTasks/fitOffTasks
// structure, customFields, temps, scopeOfWork (a leading hand reads it; the plain
// field tier is stripped of it by redactJobForViewer at read). The caller runs the
// SAME projectJobStructure + effectiveModules + redactJobForViewer pipeline the
// full read runs, on this small record instead of the monolith — so the response
// is byte-identical to the full path (modulo money, which field/LH never see).
//
// The key lives under the existing `jobs/` per-job blob namespace, already covered
// by the backup-manifest PREFIX_STORES (alongside data.json, itps.json, …) — no
// manifest change needed.

const { FIELD_AUDIENCE } = require('./job-redaction');

const DETAIL_SOURCE_KEY = 'jobs.json';

/** Per-job projection blob key (under the manifest-covered `jobs/` prefix). */
function detailKey(jobId) {
  return `jobs/${jobId}/field-detail.json`;
}

// Money fields = the adminTier audience in redaction's FIELD_AUDIENCE. Derived so
// that adding a new commercial field to redaction also drops it here — the two
// can't diverge. scopeOfWork (adminAndLH) is intentionally NOT dropped: a leading
// hand reads it; redactJobForViewer strips it for the plain field tier at read.
const MONEY_FIELDS = new Set(
  Object.entries(FIELD_AUDIENCE)
    .filter(([, audience]) => audience === 'adminTier')
    .map(([field]) => field),
);

/**
 * Pure: a full job → the field/LH-safe detail record (the job minus money). Keeps
 * all structure verbatim; the caller still runs projectJobStructure/effectiveModules
 * on it, so this performs ONLY the money strip (defence in depth vs redaction).
 */
function buildJobDetailRecord(job) {
  if (!job) return job;
  const rec = {};
  for (const k of Object.keys(job)) {
    if (!MONEY_FIELDS.has(k)) rec[k] = job[k];
  }
  return rec;
}

function realDeps() {
  const blob = require('./blob');
  return {
    readBlob: blob.readBlob,
    writeBlob: blob.writeBlob,
    blobUploadedAt: blob.blobUploadedAt,
  };
}

/**
 * Read the per-job field-detail projection for `jobId`, freshness-validated against
 * jobs.json. Returns { record, source } where:
 *   - record is the job-minus-money detail record, or null when the job is not in
 *     the monolith (caller falls through to the full read, which 404s).
 *   - source is 'detail' (fresh hit) | 'rebuilt' (miss/stale → built from the
 *     monolith + best-effort persisted).
 * Never throws for a missing projection or a failed persist; the caller treats a
 * throw as "fall back to the full jobs.json read". Deps are injectable for tests.
 */
async function readJobDetailProjection(jobId, deps = realDeps()) {
  const { readBlob, writeBlob, blobUploadedAt } = deps;

  const uploadedAt = await blobUploadedAt(DETAIL_SOURCE_KEY);

  let stored = null;
  try {
    stored = await readBlob(detailKey(jobId), null);
  } catch {
    stored = null; // corrupt/unreadable → rebuild
  }

  const fresh =
    stored &&
    stored.record &&
    uploadedAt != null &&
    stored.builtFromUploadedAt === uploadedAt;
  if (fresh) return { record: stored.record, source: 'detail' };

  // Miss / stale / can't-confirm-freshness → rebuild from the authoritative monolith.
  const jobsDoc = await readBlob(DETAIL_SOURCE_KEY, { jobs: [] });
  const job = (jobsDoc.jobs || []).find((j) => j && j.id === jobId);
  if (!job) return { record: null, source: 'rebuilt' };

  const record = buildJobDetailRecord(job);

  // Best-effort persist so the next read of this job is fast. Only stamp when we
  // actually confirmed the source's uploadedAt (else a future read can't validate
  // it and will simply rebuild again — correct, never stale).
  if (uploadedAt != null) {
    try {
      await writeBlob(detailKey(jobId), { builtFromUploadedAt: uploadedAt, record });
    } catch {
      /* best-effort: a persist failure still serves the freshly-built record */
    }
  }
  return { record, source: 'rebuilt' };
}

module.exports = {
  DETAIL_SOURCE_KEY,
  detailKey,
  MONEY_FIELDS,
  buildJobDetailRecord,
  readJobDetailProjection,
};
