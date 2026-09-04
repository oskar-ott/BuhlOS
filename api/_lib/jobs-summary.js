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
    // Cache-SKIPPING source read for the rebuild (see readJobsSummary): the
    // freshness stamp is only honest if the records were built from a jobs.json
    // as new as the uploadedAt we stamp them with.
    readBlobFresh: blob.readBlobFresh,
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
  // The rebuild MUST read the source cache-skipping. readBlob's 5s content
  // cache can hand back a jobs.json snapshot OLDER than the uploadedAt we
  // sampled fresh above; stamping those stale records with the current
  // uploadedAt marks the summary "fresh" and it is then served — with a
  // just-created job missing — until the NEXT jobs.json write. That is the
  // #1036 stale-read-stamped-fresh class of bug (there: a payroll PDF dropped
  // freshly-approved days; here: a worker adds a job and can't see it on the
  // field list). readBlobFresh closes it; fall back to readBlob only when a
  // caller (a test) injects no fresh reader.
  const readSourceFresh = deps.readBlobFresh || readBlob;

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

  // Miss / stale / can't-confirm-freshness → rebuild from the authoritative
  // monolith, read FRESH so the records can't predate the stamped uploadedAt.
  const jobsDoc = await readSourceFresh(SUMMARY_SOURCE_KEY, { jobs: [] });
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

// ---- Field LIST stats (the two the Phil jobs list actually renders) ----
// These are the SHARED source of truth for statsSnagsV2Active / statsItpsActive,
// used by BOTH the full-read enrichJobsWithStats (api/jobs.js) and the summary
// withStats path below, so the two can never diverge. They derive purely from
// the per-job blobs (data.json snagsV2[] + itps.json instances[]) — NOT from
// areaGroups — so they're computable on the summary path without the monolith.

/** Active snagsV2 = open | in_progress | resolved | rejected (mirrors
 *  needsWorkerAttention in src/domains/snags/format.ts; verified/closed excluded). */
function countActiveSnagsV2(dataDoc) {
  const arr = Array.isArray(dataDoc && dataDoc.snagsV2) ? dataDoc.snagsV2 : [];
  let n = 0;
  for (const s of arr) {
    const st = s && s.status;
    if (st === 'open' || st === 'in_progress' || st === 'resolved' || st === 'rejected') n++;
  }
  return n;
}

/** Active ITP instances = pending | in-progress | witnessed, and not archived. */
function countActiveItps(itpsDoc) {
  const arr = Array.isArray(itpsDoc && itpsDoc.instances) ? itpsDoc.instances : [];
  let n = 0;
  for (const inst of arr) {
    if (!inst || inst.archived) continue;
    const st = inst.status;
    if (st === 'pending' || st === 'in-progress' || st === 'witnessed') n++;
  }
  return n;
}

/**
 * Compute the two field-list stats for the given job ids by reading ONLY the two
 * per-job blobs they derive from (data.json + itps.json), in parallel, fail-soft
 * per job (a read error → {0,0}, matching enrichJobsWithStats's catch). Returns a
 * map jobId → { statsSnagsV2Active, statsItpsActive }. No areaGroups, no monolith,
 * no money — just the snag/ITP counts the /phil/jobs chips need. Deps injectable.
 */
async function readFieldJobStats(jobIds, deps = realDeps()) {
  const { readBlob } = deps;
  const ids = Array.isArray(jobIds) ? jobIds : [];
  const out = {};
  await Promise.all(
    ids.map(async (id) => {
      try {
        const [dataDoc, itpsDoc] = await Promise.all([
          readBlob(`jobs/${id}/data.json`, { snagsV2: [] }),
          readBlob(`jobs/${id}/itps.json`, { instances: [] }),
        ]);
        out[id] = {
          statsSnagsV2Active: countActiveSnagsV2(dataDoc),
          statsItpsActive: countActiveItps(itpsDoc),
        };
      } catch {
        out[id] = { statsSnagsV2Active: 0, statsItpsActive: 0 };
      }
    }),
  );
  return out;
}

module.exports = {
  SUMMARY_KEY,
  SUMMARY_SOURCE_KEY,
  buildJobsSummary,
  readJobsSummary,
  countActiveSnagsV2,
  countActiveItps,
  readFieldJobStats,
};
