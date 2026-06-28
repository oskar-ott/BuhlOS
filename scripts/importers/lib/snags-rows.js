// Snags row builder (#152) — PURE. No I/O, no Supabase, no Blob.
//
// Maps the per-job blob snags (data.json.snagsV2[]) into public.snags rows.
// Re-keys the legacy capture coordinate onto the canonical identity via the SAME
// shared proof-projection the evidence importer uses (the ONE resolver — they can
// never disagree):
//   areaId                → site_area_id   (composite area legacy → uuid)
//   (areaId,stage,taskId)  → task_id        (the tasks_area_stage_template_uq bridge)
//   assignedToId / *ById   → user uuids     (nullable; *_by_label preserves the name)
//
// Fail-closed, no coercion (mirrors evidence-rows):
//   * task_id is set ONLY for a FULL, RESOLVABLE (areaId, stage, taskId); a taskId
//     with an incomplete coordinate or no matching task → QUARANTINE (never attach
//     a snag to the wrong task, never silently drop to area/job level).
//   * an areaId that doesn't resolve → QUARANTINE.
//   * any status/priority/source/stage outside the schema CHECK → QUARANTINE.
//   * a missing/over-length title, over-length description/rejection_reason, or a
//     missing created_at (NOT NULL, no honest default for a historical snag) → QUARANTINE.
//
// SCOPE: snagsV2 only — the canonical live form. The legacy data.snags[] (pre-v2,
// deprecated) is NOT imported. snag_comments has NO blob source ("New capability —
// no blob equivalent today" per the schema) so none are built here.

const { taskBridgeKey, areaCompositeKey } = require('./proof-projection');

const VALID_STATUSES = ['open', 'in_progress', 'resolved', 'verified', 'closed', 'rejected'];
const VALID_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const VALID_SOURCES = ['phil', 'admin', 'system'];
const VALID_STAGES = ['roughIn', 'fitOff'];
const TITLE_MAX = 120;
const DESC_MAX = 1000;
const REJECTION_MAX = 500;

function strOrNull(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
function tsOrNull(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}

const SNAG_INSERT_COLS = [
  'tenant_id', 'job_id', 'legacy_id', 'title', 'description', 'status', 'priority',
  'source', 'stage', 'site_area_id', 'task_id', 'assigned_to',
  'acknowledged_at', 'acknowledged_by', 'acknowledged_by_label',
  'resolved_at', 'resolved_by', 'resolved_by_label',
  'verified_at', 'verified_by', 'verified_by_label',
  'closed_at', 'closed_by', 'closed_by_label',
  'rejected_at', 'rejected_by', 'rejected_by_label',
  'rejection_reason', 'created_at', 'updated_at', 'created_by', 'updated_by',
];
// Identity (legacy_id), tenant_id, job_id and created_at are immutable; everything
// else is mutable so a re-import reflects the current blob (e.g. open→resolved)
// while the IS DISTINCT FROM guard keeps an unchanged row churn-free. (revision,
// deleted_at, deleted_by are DB-managed and never written by the importer.)
const SNAG_MUTABLE_COLS = SNAG_INSERT_COLS.filter(
  (c) => !['tenant_id', 'job_id', 'legacy_id', 'created_at'].includes(c)
);

/**
 * @param {{ jobs?: {jobs?: object[]}, jobData?: Record<string, object> }} sources
 * @param {object} ctx { tenantId, jobMap, areaMap, taskMap, userMap }
 * @returns {{ snagRows: object[], quarantine: Array<{table:string,id:string,reason:string}>, byGranularity: {task:number,area:number,job:number} }}
 */
function buildSnagRows(sources = {}, ctx = {}) {
  const { jobMap, areaMap, taskMap, userMap } = ctx;
  const jobList = (sources.jobs && Array.isArray(sources.jobs.jobs) ? sources.jobs.jobs : []) || [];
  const jobData = sources.jobData || {};

  const snagRows = [];
  const quarantine = [];
  const byGranularity = { task: 0, area: 0, job: 0 };
  const seen = new Set();
  const user = (id) => (id && userMap && userMap.get(id)) || null;

  for (const job of jobList) {
    if (!job || !job.id) continue;
    const job_id = jobMap.get(job.id);
    const list = Array.isArray(jobData[job.id] && jobData[job.id].snagsV2) ? jobData[job.id].snagsV2 : [];
    for (const s of list) {
      const Q = (reason) => quarantine.push({ table: 'snags', id: (s && s.id) || `(job ${job.id})`, reason });
      if (!s || !s.id) { Q('snag requires an id'); continue; }
      if (seen.has(s.id)) { Q(`duplicate snag id "${s.id}"`); continue; }
      if (!job_id) { Q(`job ${job.id} not found in Postgres`); continue; }

      const title = strOrNull(s.title);
      if (!title) { Q('title missing (NOT NULL column)'); continue; }
      if (title.length > TITLE_MAX) { Q(`title exceeds ${TITLE_MAX} chars`); continue; }
      const description = strOrNull(s.description);
      if (description && description.length > DESC_MAX) { Q(`description exceeds ${DESC_MAX} chars`); continue; }
      if (!VALID_STATUSES.includes(s.status)) { Q(`status "${s.status}" outside CHECK`); continue; }
      if (!VALID_PRIORITIES.includes(s.priority)) { Q(`priority "${s.priority}" outside CHECK`); continue; }
      if (!VALID_SOURCES.includes(s.source)) { Q(`source "${s.source}" outside CHECK (phil/admin/system)`); continue; }
      if (s.stage != null && !VALID_STAGES.includes(s.stage)) { Q(`stage "${s.stage}" outside CHECK`); continue; }
      const rejection_reason = strOrNull(s.rejectionReason);
      if (rejection_reason && rejection_reason.length > REJECTION_MAX) { Q(`rejection_reason exceeds ${REJECTION_MAX} chars`); continue; }
      const created_at = tsOrNull(s.createdAt);
      if (!created_at) { Q('created_at missing/invalid (NOT NULL column, no honest default)'); continue; }

      // Re-key area (fail closed on an unresolvable areaId).
      let site_area_id = null;
      if (s.areaId) {
        site_area_id = areaMap.get(areaCompositeKey(job.id, s.areaId));
        if (!site_area_id) { Q(`areaId "${s.areaId}" does not resolve to a site_area`); continue; }
      }
      // Re-key task — ONLY a full coordinate, ONLY to an existing task.
      let task_id = null;
      if (s.taskId) {
        const key = taskBridgeKey(job.id, s.areaId, s.stage, s.taskId);
        if (!key) { Q(`taskId "${s.taskId}" without a full (areaId,stage) coordinate`); continue; }
        task_id = taskMap.get(key);
        if (!task_id) { Q(`taskId "${s.taskId}" (${key}) does not resolve to a task`); continue; }
      }

      seen.add(s.id);
      byGranularity[task_id ? 'task' : site_area_id ? 'area' : 'job'] += 1;
      snagRows.push({
        tenant_id: ctx.tenantId,
        job_id,
        legacy_id: s.id,
        title,
        description,
        status: s.status,
        priority: s.priority,
        source: s.source,
        stage: s.stage || null,
        site_area_id,
        task_id,
        assigned_to: user(s.assignedToId),
        acknowledged_at: tsOrNull(s.acknowledgedAt),
        acknowledged_by: user(s.acknowledgedById),
        acknowledged_by_label: strOrNull(s.acknowledgedByName),
        resolved_at: tsOrNull(s.resolvedAt),
        resolved_by: user(s.resolvedById),
        resolved_by_label: strOrNull(s.resolvedByName),
        verified_at: tsOrNull(s.verifiedAt),
        verified_by: user(s.verifiedById),
        verified_by_label: strOrNull(s.verifiedByName),
        closed_at: tsOrNull(s.closedAt),
        closed_by: user(s.closedById),
        closed_by_label: strOrNull(s.closedByName),
        rejected_at: tsOrNull(s.rejectedAt),
        rejected_by: user(s.rejectedById),
        rejected_by_label: strOrNull(s.rejectedByName),
        rejection_reason,
        created_at,
        updated_at: tsOrNull(s.updatedAt) || created_at,
        created_by: user(s.createdById),
        updated_by: null, // blob has no distinct updatedBy; transition actors carry attribution
      });
    }
  }
  return { snagRows, quarantine, byGranularity };
}

module.exports = { buildSnagRows, SNAG_INSERT_COLS, SNAG_MUTABLE_COLS };
