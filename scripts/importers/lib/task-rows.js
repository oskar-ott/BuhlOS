// J3 task + task_status_event row builder — PURE. No I/O, no Supabase, no Blob.
//
// Maps the projection's EXPANDED instances (the ONE expansion engine,
// scripts/importers/lib/task-projection.js) into the row payloads the J3 importer
// upserts. It does NOT re-expand or re-resolve status — it consumes
// projection.instances verbatim, so there is exactly one expansion implementation.
//
// FK resolution is fail-closed: every instance must resolve to a tenant, job,
// site_area, and task_template (by the override-aware templateScope). A missing FK
// throws — the importer aborts the transaction rather than write an orphan.
//
// Identity = (tenant_id, site_area_id, stage, legacy_template_id) = the
// tasks_area_stage_template_uq bridge. legacy_template_id is the BARE taskId
// (1:1 with the in-code ct_<hash>); Supabase mints tasks.id. No third identity.

// The mutable cols the upsert overwrites on conflict (everything except the
// identity key — legacy_template_id, stage, site_area_id — and created_at, which
// is insert-only / DB-defaulted). Kept in lock-step with the importer's SET and
// the sync-check's compared fields. task_template_id is here (not identity): the
// identity is legacy_template_id, and task_template_id would only change if an
// area override were added/removed — which the projection gate already flags
// upstream — so at import time it is effectively immutable (the IS DISTINCT FROM
// guard re-writes the identical resolved FK = no-op).
const TASK_MUTABLE_COLS = ['name', 'status', 'sort_order', 'task_template_id'];
// created_at omitted → DB default now() (blob has no per-instance timestamp);
// deleted_at omitted → null (blob has no per-instance archival — archived
// templates/areas are SUPPRESSED upstream, never produced as instances).
const TASK_INSERT_COLS = [
  'tenant_id', 'job_id', 'site_area_id', 'task_template_id', 'legacy_template_id',
  'stage', 'name', 'status', 'sort_order',
];
const EVENT_INSERT_COLS = ['tenant_id', 'task_id', 'from_status', 'to_status', 'source', 'actor_label', 'created_at'];

const IMPORT_EVENT_SOURCE = 'blob-migration';
const IMPORT_EVENT_ACTOR = 'migration';

/**
 * @param {Array<object>} instances projection.instances
 * @param {object} ctx { tenantId, jobMap, areaMap, jobTemplateMap, areaTemplateMap }
 *   jobMap:   jobLegacy → job uuid
 *   areaMap:  areaLegacy → site_area uuid
 *   jobTemplateMap:  `${jobLegacy}|${stage}|${legacyId}`  → job_task_template uuid (site_area_id NULL)
 *   areaTemplateMap: `${areaLegacy}|${stage}|${legacyId}` → job_task_template uuid (area override)
 * @returns {Array<object>} task insert rows (FK-resolved). Throws on any missing FK.
 */
function buildTaskRows(instances, ctx) {
  const { tenantId, jobMap, areaMap, jobTemplateMap, areaTemplateMap } = ctx;
  return (instances || []).map((inst) => {
    const job_id = jobMap.get(inst.jobLegacy);
    if (!job_id) throw new Error(`task ${inst.areaLegacy}/${inst.stage}/${inst.legacyTemplateId}: job ${inst.jobLegacy} not found in Postgres`);
    const site_area_id = areaMap.get(inst.areaLegacy);
    if (!site_area_id) throw new Error(`task ${inst.areaLegacy}/${inst.stage}/${inst.legacyTemplateId}: site_area ${inst.areaLegacy} not found in Postgres`);

    const tplKey =
      inst.templateScope === 'area'
        ? `${inst.areaLegacy}|${inst.stage}|${inst.legacyTemplateId}`
        : `${inst.jobLegacy}|${inst.stage}|${inst.legacyTemplateId}`;
    const task_template_id =
      inst.templateScope === 'area' ? areaTemplateMap.get(tplKey) : jobTemplateMap.get(tplKey);
    if (!task_template_id) {
      throw new Error(`task ${inst.areaLegacy}/${inst.stage}/${inst.legacyTemplateId}: ${inst.templateScope}-level template not found in Postgres (key ${tplKey})`);
    }

    return {
      tenant_id: tenantId,
      job_id,
      site_area_id,
      task_template_id,
      legacy_template_id: inst.legacyTemplateId,
      stage: inst.stage,
      name: inst.name,
      status: inst.status,
      sort_order: inst.sortOrder,
    };
  });
}

/**
 * One import event per task — the imported-state BASELINE (from→to), no fake
 * history. Built only for tasks the upsert actually INSERTED (see the importer),
 * so a re-run creates zero events.
 * @param {string} tenantId
 * @param {Array<{id: string, status: string}>} insertedTasks
 * @param {string} nowIso
 */
function buildEventRows(tenantId, insertedTasks, nowIso) {
  return (insertedTasks || []).map((t) => ({
    tenant_id: tenantId,
    task_id: t.id,
    from_status: null,
    to_status: t.status,
    source: IMPORT_EVENT_SOURCE,
    actor_label: IMPORT_EVENT_ACTOR,
    created_at: nowIso,
  }));
}

module.exports = {
  buildTaskRows,
  buildEventRows,
  TASK_MUTABLE_COLS,
  TASK_INSERT_COLS,
  EVENT_INSERT_COLS,
  IMPORT_EVENT_SOURCE,
  IMPORT_EVENT_ACTOR,
};
