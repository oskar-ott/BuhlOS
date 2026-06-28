// Observations row builder (#152) — PURE. No I/O, no Supabase, no Blob.
//
// Maps the org-wide blob observations (observations.json {observations:[]}) into
// public.observations rows. Re-keys the legacy coordinate onto canonical identity
// via the SAME shared proof-projection the evidence + snags importers use:
//   areaId                → site_area_id   (composite area legacy → uuid)
//   (areaId,stage,taskId)  → task_id        (the tasks_area_stage_template_uq bridge)
//   assignedToId/resolvedById/createdById → user uuids (nullable; no label column)
//   linkedSnagId           → linked_snag_id (best-effort via snagMap; dangling → null)
//
// Fail-closed, no coercion:
//   * job_id is NOT NULL in the schema — an observation with no jobId (an "office
//     item") CANNOT be represented → QUARANTINE (needs a schema change to migrate).
//   * an unresolvable jobId/areaId, a taskId without a full/resolvable coordinate,
//     or any type/status/priority/source/stage/converted_to outside the schema CHECK
//     → QUARANTINE. A missing/over-length title, over-length description/resolution,
//     or a missing created_at → QUARANTINE.
//   * linked_snag_id is best-effort (a dangling link nulls, never quarantines — the
//     observation is still valid). linked_material_request_id is ALWAYS null here:
//     materials are a later rung, so that link is backfilled separately.
//
// DROPPED (no PG column — out of this table's scope, documented): jobName/areaName/
// taskName/*Name labels, variation* detail fields, convertedTargetId/convertedBy/At,
// linkedRfiId, linkedEvidenceId (evidence provenance lives in evidence_links).

const { taskBridgeKey, areaCompositeKey } = require('./proof-projection');

const VALID_TYPES = ['note', 'blocker', 'rfi', 'variation', 'defect', 'safety', 'material_request', 'plan_mismatch', 'client_instruction', 'evidence'];
const VALID_STATUSES = ['new', 'needs_action', 'in_review', 'converted', 'resolved', 'record_only'];
const VALID_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const VALID_SOURCES = ['phil', 'buhlos', 'system'];
const VALID_STAGES = ['roughIn', 'fitOff'];
const VALID_CONVERTED = ['rfi', 'variation', 'defect', 'snag', 'material_request', 'task'];
const TITLE_MAX = 140;
const DESC_MAX = 2000;
const RESOLUTION_MAX = 1000;

function strOrNull(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
function tsOrNull(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}
function dateOrNull(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
function strArray(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim() !== '') : [];
}

const OBSERVATION_INSERT_COLS = [
  'tenant_id', 'job_id', 'legacy_id', 'type', 'title', 'description', 'status', 'priority',
  'source', 'requires_action', 'stage', 'site_area_id', 'task_id', 'assigned_to', 'due_date',
  'photo_urls', 'linked_snag_id', 'linked_material_request_id', 'converted_to', 'resolution_note',
  'resolved_at', 'resolved_by', 'created_at', 'updated_at', 'created_by', 'updated_by',
];
// Identity (legacy_id), tenant_id, job_id and created_at are immutable; the rest is
// mutable so a re-import reflects the current blob (e.g. new→converted) while the
// IS DISTINCT FROM guard keeps unchanged rows churn-free.
const OBSERVATION_MUTABLE_COLS = OBSERVATION_INSERT_COLS.filter(
  (c) => !['tenant_id', 'job_id', 'legacy_id', 'created_at'].includes(c)
);

/**
 * @param {{ observations?: {observations?: object[]} }} sources
 * @param {object} ctx { tenantId, jobMap, areaMap, taskMap, userMap, snagMap }
 * @returns {{ observationRows: object[], quarantine: Array<{table:string,id:string,reason:string}>, byGranularity: {task:number,area:number,job:number} }}
 */
function buildObservationRows(sources = {}, ctx = {}) {
  const { jobMap, areaMap, taskMap, userMap, snagMap } = ctx;
  const list = (sources.observations && Array.isArray(sources.observations.observations) ? sources.observations.observations : []) || [];

  const observationRows = [];
  const quarantine = [];
  const byGranularity = { task: 0, area: 0, job: 0 };
  const seen = new Set();
  const user = (id) => (id && userMap && userMap.get(id)) || null;

  for (const o of list) {
    const Q = (reason) => quarantine.push({ table: 'observations', id: (o && o.id) || '(no id)', reason });
    if (!o || !o.id) { Q('observation requires an id'); continue; }
    if (seen.has(o.id)) { Q(`duplicate observation id "${o.id}"`); continue; }
    // job_id is NOT NULL — office items (jobId null) cannot be represented yet.
    if (!o.jobId) { Q('observation has no jobId (office item — job_id is NOT NULL; needs a schema change to migrate)'); continue; }
    const job_id = jobMap.get(o.jobId);
    if (!job_id) { Q(`job "${o.jobId}" not found in Postgres`); continue; }

    if (!VALID_TYPES.includes(o.type)) { Q(`type "${o.type}" outside CHECK`); continue; }
    const title = strOrNull(o.title);
    if (!title) { Q('title missing (NOT NULL column)'); continue; }
    if (title.length > TITLE_MAX) { Q(`title exceeds ${TITLE_MAX} chars`); continue; }
    const description = strOrNull(o.description);
    if (description && description.length > DESC_MAX) { Q(`description exceeds ${DESC_MAX} chars`); continue; }
    if (!VALID_STATUSES.includes(o.status)) { Q(`status "${o.status}" outside CHECK`); continue; }
    if (!VALID_PRIORITIES.includes(o.priority)) { Q(`priority "${o.priority}" outside CHECK`); continue; }
    if (!VALID_SOURCES.includes(o.source)) { Q(`source "${o.source}" outside CHECK (phil/buhlos/system)`); continue; }
    if (o.stage != null && !VALID_STAGES.includes(o.stage)) { Q(`stage "${o.stage}" outside CHECK`); continue; }
    if (o.convertedTo != null && !VALID_CONVERTED.includes(o.convertedTo)) { Q(`convertedTo "${o.convertedTo}" outside CHECK`); continue; }
    const resolution_note = strOrNull(o.resolutionNote);
    if (resolution_note && resolution_note.length > RESOLUTION_MAX) { Q(`resolution_note exceeds ${RESOLUTION_MAX} chars`); continue; }
    const created_at = tsOrNull(o.createdAt);
    if (!created_at) { Q('created_at missing/invalid (NOT NULL column, no honest default)'); continue; }

    // Re-key area (fail closed on an unresolvable areaId).
    let site_area_id = null;
    if (o.areaId) {
      site_area_id = areaMap.get(areaCompositeKey(o.jobId, o.areaId));
      if (!site_area_id) { Q(`areaId "${o.areaId}" does not resolve to a site_area`); continue; }
    }
    // Re-key task — ONLY a full coordinate, ONLY to an existing task.
    let task_id = null;
    if (o.taskId) {
      const key = taskBridgeKey(o.jobId, o.areaId, o.stage, o.taskId);
      if (!key) { Q(`taskId "${o.taskId}" without a full (areaId,stage) coordinate`); continue; }
      task_id = taskMap.get(key);
      if (!task_id) { Q(`taskId "${o.taskId}" (${key}) does not resolve to a task`); continue; }
    }

    seen.add(o.id);
    byGranularity[task_id ? 'task' : site_area_id ? 'area' : 'job'] += 1;
    observationRows.push({
      tenant_id: ctx.tenantId,
      job_id,
      legacy_id: o.id,
      type: o.type,
      title,
      description,
      status: o.status,
      priority: o.priority,
      source: o.source,
      requires_action: Boolean(o.requiresAction),
      stage: o.stage || null,
      site_area_id,
      task_id,
      assigned_to: user(o.assignedToId),
      due_date: dateOrNull(o.dueDate),
      photo_urls: strArray(o.photoUrls),
      // best-effort: a dangling snag link nulls (the observation is still valid).
      linked_snag_id: (o.linkedSnagId && snagMap && snagMap.get(o.linkedSnagId)) || null,
      // materials are a later rung — this link is backfilled then, never guessed now.
      linked_material_request_id: null,
      converted_to: o.convertedTo || null,
      resolution_note,
      resolved_at: tsOrNull(o.resolvedAt),
      resolved_by: user(o.resolvedById),
      created_at,
      updated_at: tsOrNull(o.updatedAt) || created_at,
      created_by: user(o.createdById),
      updated_by: null,
    });
  }
  return { observationRows, quarantine, byGranularity };
}

module.exports = { buildObservationRows, OBSERVATION_INSERT_COLS, OBSERVATION_MUTABLE_COLS };
