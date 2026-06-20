// Proof/evidence coordinate projection — PURE. The ONE place that converts a
// legacy proof coordinate (jobId, areaId, stage, taskId) into the canonical task
// identity, reused by the J4 evidence importer AND the evidence sync-check so the
// two can never disagree. No duplicate resolution logic.
//
// The canonical task bridge (J3) is (site_area, stage, legacy_template_id), where
// site_area is the J1 composite area legacy_id and legacy_template_id is the bare
// taskId. So an evidence record captured at (jobId, areaId, stage, taskId) resolves
// to a task via taskBridgeKey(...) → the SAME key the PG tasks read is keyed by.
//
// Granularity is honest: an evidence item is TASK-level only if it carries a full,
// resolvable (areaId, stage, taskId); AREA-level if it has only an areaId; else
// JOB-level. We NEVER promote area/job/package proof to a task (no fabricated
// task-level certainty) — taskBridgeKey returns null unless the full coordinate is
// present, and the importer leaves task_id NULL.

const { compositeLegacyId } = require('./structure-legacy-id');

/**
 * The (area, stage, taskId) bridge key for a proof coordinate, matching the PG
 * tasks read key `${areaLegacy}|${stage}|${legacy_template_id}`. Returns null
 * unless ALL of areaId, stage and taskId are present (a partial coordinate is not
 * task-level — never guessed onto a task).
 */
function taskBridgeKey(jobLegacyId, areaId, stage, taskId) {
  if (!areaId || !stage || !taskId) return null;
  return `${compositeLegacyId(jobLegacyId, areaId)}|${stage}|${taskId}`;
}

/** The composite area legacy_id for an evidence coordinate (null if no areaId). */
function areaCompositeKey(jobLegacyId, areaId) {
  return areaId ? compositeLegacyId(jobLegacyId, areaId) : null;
}

/**
 * Honest proof granularity from the resolvable coordinate parts of an evidence
 * record. 'task' needs a full (areaId, stage, taskId); 'area' needs an areaId;
 * otherwise 'job'. (There is no PG 'area' link type — area-granularity lives on
 * evidence_files.site_area_id, not in evidence_links.)
 */
function proofGranularity({ areaId, stage, taskId } = {}) {
  if (areaId && stage && taskId) return 'task';
  if (areaId) return 'area';
  return 'job';
}

module.exports = { taskBridgeKey, areaCompositeKey, proofGranularity };
