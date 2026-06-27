// Phil FIELD jobs-summary projection (perf — Phil mobile LCP).
//
// /api/jobs's field LIST read had to fetch + parse the whole jobs.json monolith
// (~3.5s uncached) just to emit a small per-worker summary. This derives a small
// `jobs-summary.json` and serves the field/leading-hand plain LIST from it.
//
// SAFE BY CONSTRUCTION:
//   * Blob authoritative — jobs.json is never replaced; the summary is a derived
//     cache rebuilt from it.
//   * Never stale — every read validates the summary's `builtFromUploadedAt`
//     against jobs.json's CURRENT blob uploadedAt (a metadata-only list(), no
//     content fetch); any mismatch/miss → rebuild from the monolith.
//   * Always falls back — missing/corrupt summary, or any error, rebuilds from
//     (or the caller falls back to) the full jobs.json read.
//   * No write-path change — the summary is rebuilt lazily on read, so every one
//     of the 8+ jobs.json writers invalidates it automatically (their write
//     advances jobs.json's uploadedAt).
//
// The record is the SUPERSET of field-kept job fields MINUS the heavy structure
// (areaGroups / roughInTasks / fitOffTasks / customFields / temps) and ALL money
// fields. Structure is dropped because no field LIST consumer reads it (the
// single-job ?id= detail GET is the only structure consumer and keeps the full
// read); money is dropped so the cheap path can never carry commercial figures
// even on a redaction bug (they are stripped for every field role anyway).
// typeName is pre-resolved at build time so the read path needs no job-types.json.
// Per-viewer transforms (assignedJobIds visibility + redactJobForViewer) run on
// top at the call site, exactly as on the full-read path — parity by construction.

const SUMMARY_KEY = 'jobs-summary.json';
const SUMMARY_SOURCE_KEY = 'jobs.json';

// Heavy / commercial fields excluded from every summary record.
const DROP_FIELDS = new Set([
  // structure (the bulk of jobs.json; no field LIST consumer reads it)
  'areaGroups', 'roughInTasks', 'fitOffTasks', 'customFields', 'temps',
  // money (stripped for all field roles by redactJobForViewer; omitted here too)
  'contractValue', 'labourEstimate', 'materialEstimate',
  'claimedToDate', 'paidToDate', 'oldestClaimDays',
]);

/**
 * Pure: full jobs[] + jobTypes[] → small field-summary records[]. Copies every
 * non-heavy, non-money field (a faithful superset, robust to future field-list
 * additions) and pre-resolves typeName, mirroring the full path's enrichment
 * (`j.type && typeMap[j.type] ? typeName : —`).
 */
function buildJobsSummary(jobs, jobTypes) {
  const typeNameById = {};
  for (const t of jobTypes || []) {
    if (t && t.id != null) typeNameById[t.id] = t.name;
  }
  return (jobs || []).map((j) => {
    const rec = {};
    for (const k of Object.keys(j || {})) {
      if (!DROP_FIELDS.has(k)) rec[k] = j[k];
    }
    if (j && j.type && typeNameById[j.type]) rec.typeName = typeNameById[j.type];
    return rec;
  });
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
 * Read the field jobs-summary, freshness-validated against jobs.json. Returns
 * { records, source } where source is 'summary' (fresh hit) or 'rebuilt' (miss/
 * stale → built from the monolith + best-effort persisted). Never throws for a
 * missing summary or a failed persist; the caller treats a throw as "fall back
 * to the full jobs.json read". Deps are injectable for tests.
 */
async function readJobsSummary(deps = realDeps()) {
  const { readBlob, writeBlob, blobUploadedAt } = deps;

  const uploadedAt = await blobUploadedAt(SUMMARY_SOURCE_KEY);

  let summary = null;
  try {
    summary = await readBlob(SUMMARY_KEY, null);
  } catch {
    summary = null; // corrupt/unreadable → rebuild
  }

  const fresh =
    summary &&
    Array.isArray(summary.records) &&
    uploadedAt != null &&
    summary.builtFromUploadedAt === uploadedAt;
  if (fresh) return { records: summary.records, source: 'summary' };

  // Miss / stale / can't-confirm-freshness → rebuild from the authoritative monolith.
  const jobsDoc = await readBlob(SUMMARY_SOURCE_KEY, { jobs: [] });
  const jobTypesDoc = await readBlob('job-types.json', { jobTypes: [] });
  const records = buildJobsSummary(jobsDoc.jobs || [], jobTypesDoc.jobTypes || []);

  // Best-effort persist so the next read is fast. Only stamp when we actually
  // confirmed the source's uploadedAt (else a future read can't validate it and
  // will simply rebuild again — correct, never stale).
  if (uploadedAt != null) {
    try {
      await writeBlob(SUMMARY_KEY, { builtFromUploadedAt: uploadedAt, records });
    } catch {
      /* best-effort: a persist failure still serves the freshly-built records */
    }
  }
  return { records, source: 'rebuilt' };
}

module.exports = { SUMMARY_KEY, SUMMARY_SOURCE_KEY, buildJobsSummary, readJobsSummary };
