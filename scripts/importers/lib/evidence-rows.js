// J4 evidence + evidence-link row builder — PURE. No I/O, no Supabase, no Blob.
//
// Maps the per-job blob evidence (data.json.evidence[]) into evidence_files rows
// (METADATA ONLY — blob_url/photo_blob_id are references; binaries stay in Blob)
// and the task-proof evidence_links rows. Re-keys the legacy coordinate to the
// canonical identity via the SHARED proof-projection (one resolver):
//   areaId            → site_area_id   (composite area legacy → uuid)
//   (areaId,stage,taskId) → task_id    (the tasks_area_stage_template_uq bridge)
//   capturedById/reviewedById → user uuids (nullable; label preserves the name)
//
// HONEST granularity, fail-closed:
//   * task_id is set ONLY when the evidence carries a FULL, RESOLVABLE
//     (areaId, stage, taskId). A taskId present but with an incomplete coordinate
//     or no matching task → QUARANTINE (never attach to the wrong task).
//   * an areaId that doesn't resolve → QUARANTINE.
//   * evidence_links(task, 'proof') is created ONLY for evidence whose own capture
//     coordinate resolved to a task — package/area/job evidence gets NO task link
//     (no fabricated task-level certainty). Area-granularity lives on
//     evidence_files.site_area_id; there is no PG 'area' link type.

const { taskBridgeKey, areaCompositeKey, proofGranularity } = require('./proof-projection');

const VALID_KINDS = ['photo', 'note'];
const VALID_STATUSES = ['submitted', 'reviewed', 'rejected'];
const VALID_SOURCES = ['phil', 'admin', 'system'];
const VALID_STAGES = ['roughIn', 'fitOff'];
const NOTE_MAX = 280;
const REJECTION_MAX = 500;

function strOrNull(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
function tsOrNull(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}
function exifPart(loc, keys) {
  if (!loc || typeof loc !== 'object') return null;
  for (const k of keys) if (Number.isFinite(loc[k])) return loc[k];
  return null;
}

const EVIDENCE_INSERT_COLS = [
  'tenant_id', 'job_id', 'legacy_id', 'kind', 'photo_blob_id', 'blob_url', 'thumbnail_url',
  'note', 'site_area_id', 'task_id', 'stage', 'captured_by', 'captured_by_label', 'captured_at',
  'client_captured_at', 'exif_lat', 'exif_lng', 'status', 'source', 'reviewed_by',
  'reviewed_by_label', 'reviewed_at', 'rejection_reason', 'created_at',
];
// Everything except the identity (legacy_id), tenant_id, job_id and created_at is
// mutable, so a re-import reflects the current blob state (e.g. submitted→reviewed)
// while the IS DISTINCT FROM guard keeps an unchanged row churn-free.
const EVIDENCE_MUTABLE_COLS = EVIDENCE_INSERT_COLS.filter(
  (c) => !['tenant_id', 'job_id', 'legacy_id', 'created_at'].includes(c)
);
const EVIDENCE_LINK_INSERT_COLS = ['tenant_id', 'evidence_file_id', 'linked_entity_type', 'linked_entity_id', 'link_role'];

/**
 * @param {{ jobs?: {jobs?: object[]}, jobData?: Record<string, object> }} sources
 * @param {object} ctx { tenantId, jobMap, areaMap, taskMap, userMap }
 * @returns {{ evidenceRows, quarantine, byGranularity }}
 */
function buildEvidenceRows(sources = {}, ctx = {}) {
  const { jobMap, areaMap, taskMap, userMap } = ctx;
  const jobList = (sources.jobs && Array.isArray(sources.jobs.jobs) ? sources.jobs.jobs : []) || [];
  const jobData = sources.jobData || {};

  const evidenceRows = [];
  const quarantine = [];
  const byGranularity = { task: 0, area: 0, job: 0 };
  const seen = new Set();

  for (const job of jobList) {
    if (!job || !job.id) continue;
    const job_id = jobMap.get(job.id);
    const list = Array.isArray(jobData[job.id] && jobData[job.id].evidence) ? jobData[job.id].evidence : [];
    for (const e of list) {
      const Q = (reason) => quarantine.push({ table: 'evidence_files', id: (e && e.id) || `(job ${job.id})`, reason });
      if (!e || !e.id) { Q('evidence requires an id'); continue; }
      if (seen.has(e.id)) { Q(`duplicate evidence id "${e.id}"`); continue; }
      if (!job_id) { Q(`job ${job.id} not found in Postgres`); continue; }
      if (!VALID_KINDS.includes(e.kind)) { Q(`kind "${e.kind}" outside CHECK (photo/note)`); continue; }
      if (!VALID_STATUSES.includes(e.status)) { Q(`status "${e.status}" outside CHECK`); continue; }
      if (!VALID_SOURCES.includes(e.source)) { Q(`source "${e.source}" outside CHECK (phil/admin/system)`); continue; }
      const captured_at = tsOrNull(e.capturedAt);
      if (!captured_at) { Q('captured_at missing/invalid (NOT NULL column)'); continue; }
      if (e.stage != null && !VALID_STAGES.includes(e.stage)) { Q(`stage "${e.stage}" outside CHECK`); continue; }

      const note = strOrNull(e.note);
      const blob_url = strOrNull(e.photoUrl);
      if (e.kind === 'photo' && !blob_url) { Q('photo evidence has no photoUrl (CHECK requires blob_url)'); continue; }
      if (e.kind === 'note' && !note) { Q('note evidence has no note text (CHECK requires note)'); continue; }
      if (note && note.length > NOTE_MAX) { Q(`note exceeds ${NOTE_MAX} chars`); continue; }
      const rejection_reason = strOrNull(e.rejectionReason);
      if (rejection_reason && rejection_reason.length > REJECTION_MAX) { Q(`rejection_reason exceeds ${REJECTION_MAX} chars`); continue; }

      // Re-key area (fail closed on an unresolvable areaId).
      let site_area_id = null;
      if (e.areaId) {
        site_area_id = areaMap.get(areaCompositeKey(job.id, e.areaId));
        if (!site_area_id) { Q(`areaId "${e.areaId}" does not resolve to a site_area`); continue; }
      }
      // Re-key task — ONLY a full coordinate, ONLY to an existing task. A taskId
      // with an incomplete coordinate or no matching task is a hard error (never
      // silently dropped to job-level, never attached to the wrong task).
      let task_id = null;
      if (e.taskId) {
        const key = taskBridgeKey(job.id, e.areaId, e.stage, e.taskId);
        if (!key) { Q(`taskId "${e.taskId}" without a full (areaId,stage) coordinate`); continue; }
        task_id = taskMap.get(key);
        if (!task_id) { Q(`taskId "${e.taskId}" (${key}) does not resolve to a task`); continue; }
      }

      seen.add(e.id);
      byGranularity[proofGranularity(e)] += 1;
      evidenceRows.push({
        tenant_id: ctx.tenantId,
        job_id,
        legacy_id: e.id,
        kind: e.kind,
        photo_blob_id: strOrNull(e.photoId),
        blob_url,
        thumbnail_url: strOrNull(e.thumbnailUrl),
        note,
        site_area_id,
        task_id,
        stage: e.stage || null,
        captured_by: (userMap && userMap.get(e.capturedById)) || null,
        captured_by_label: strOrNull(e.capturedByName),
        captured_at,
        client_captured_at: tsOrNull(e.clientCapturedAt),
        exif_lat: exifPart(e.exifLocation, ['lat', 'latitude']),
        exif_lng: exifPart(e.exifLocation, ['lng', 'longitude']),
        status: e.status,
        source: e.source,
        reviewed_by: (userMap && userMap.get(e.reviewedById)) || null,
        reviewed_by_label: strOrNull(e.reviewedByName),
        reviewed_at: tsOrNull(e.reviewedAt),
        rejection_reason,
        created_at: tsOrNull(e.createdAt) || captured_at,
      });
    }
  }
  return { evidenceRows, quarantine, byGranularity };
}

/**
 * Task-proof links for the upserted evidence files that resolved to a task.
 * @param {string} tenantId
 * @param {Array<{id: string, task_id: string|null}>} evidenceWithIds
 */
function buildEvidenceLinkRows(tenantId, evidenceWithIds) {
  return (evidenceWithIds || [])
    .filter((r) => r.task_id)
    .map((r) => ({
      tenant_id: tenantId,
      evidence_file_id: r.id,
      linked_entity_type: 'task',
      linked_entity_id: r.task_id,
      link_role: 'proof',
    }));
}

module.exports = {
  buildEvidenceRows,
  buildEvidenceLinkRows,
  EVIDENCE_INSERT_COLS,
  EVIDENCE_MUTABLE_COLS,
  EVIDENCE_LINK_INSERT_COLS,
};
