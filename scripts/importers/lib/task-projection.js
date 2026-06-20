// Task-expansion projection — PURE. No I/O, no Supabase, no Blob, NO WRITES.
//
// J3-PREP / validation gate (NOT the tasks importer). Answers, before a single
// `tasks` row is ever written: exactly which canonical task INSTANCES would J3
// create by expanding the imported job_task_templates (J2) across the live areas,
// and does every canonical identity hold? J3 should only be written once this
// projection is clean (0 collisions, 0 orphaned recorded state).
//
// Expansion rule (the SAME one J3 must use) = one task instance per EFFECTIVE
// template per LIVE area per stage, where "effective" is the override-wins
// resolution already in structure-plan.effectiveEntries (a non-empty, live area
// override list wins; otherwise the job-level default; archived entries excluded).
// This is DISTINCT from J2, which imported the raw template DEFINITIONS at both
// levels — here we RESOLVE them per area into the instances J3 will materialise.
//
// Canonical identity of an instance = the (site_area, stage, legacy_template_id)
// bridge, where site_area is the J1/J2 composite area legacy_id and
// legacy_template_id is the BARE blob taskId — exactly the tasks_area_stage_template_uq
// key J3 will write on, and 1:1 with the in-code ct_<hash> (FNV-1a of
// jobId::areaId::stage::taskId). A collision = the same identity produced twice
// (a dup taskId within one area+stage) → J3 would hit the unique index.
//
// Status comes from the recorded blob state (data.json
// dwellings[areaId][stage].tasks[taskId]); recorded state that maps to NO produced
// instance (wrong/archived area, or a taskId not in the effective list) is
// ORPHANED — recorded progress J3 would silently drop, surfaced here.

const { effectiveEntries, STAGES, STAGE_KEYS, VALID_TASK_STATES } = require('./structure-plan');
const { compositeLegacyId } = require('./structure-legacy-id');

function liveTemplateEntries(list) {
  return (Array.isArray(list) ? list : []).filter((t) => t && t.id && t.name && !t.archived);
}

/**
 * @param {{ jobs?: {jobs?: object[]}, jobData?: Record<string, object> }} sources
 * @returns a projection: per-job/area/stage instance counts, totals, overrides,
 *   suppressed, orphaned recorded state, and canonical-identity collisions.
 */
function buildTaskProjection(sources = {}) {
  const jobList = (sources.jobs && Array.isArray(sources.jobs.jobs) ? sources.jobs.jobs : []) || [];
  const jobData = sources.jobData || {};

  const jobs = [];
  const instances = []; // the EXPANDED task instance rows — the J3 importer + sync-check consume these
  const collisions = [];
  const malformed = []; // effective entry with no id → no valid legacy_template_id (J2 would quarantine)
  const badStatus = []; // recorded state outside the schema CHECK — fail closed, NEVER coerce
  const orphanedState = [];
  let templates = 0; // distinct live template DEFINITIONS (job-level + live-area overrides) = the J2 count
  let overrides = 0; // (area, stage) lists sourced from a live area override
  const byStage = { roughIn: 0, fitOff: 0 };
  const byStatus = { not_started: 0, in_progress: 0, complete: 0 };
  const suppressed = { archivedAreas: 0, archivedTemplates: 0 };

  const seenIdentity = new Set(); // `${areaLegacy}|${stage}|${taskId}` — the canonical bridge

  for (const job of jobList) {
    if (!job || !job.id || !job.name) continue; // invalid jobs are J1's concern, not the projection's
    const data = jobData[job.id] || {};
    const dwellings = (data && data.dwellings) || {};

    // Count this job's live template DEFINITIONS (job-level + live-area overrides),
    // and tally archived template entries as suppressed.
    for (const stage of STAGES) {
      const key = STAGE_KEYS[stage];
      templates += liveTemplateEntries(job[key]).length;
      suppressed.archivedTemplates += (Array.isArray(job[key]) ? job[key] : []).filter((t) => t && t.id && t.name && t.archived).length;
    }

    const liveAreas = new Map(); // areaId → { area, areaLegacy }
    for (const group of Array.isArray(job.areaGroups) ? job.areaGroups : []) {
      for (const area of Array.isArray(group.areas) ? group.areas : []) {
        if (!area || !area.id || !area.name) continue;
        if (area.archived) { suppressed.archivedAreas += 1; continue; }
        liveAreas.set(area.id, { area, areaLegacy: compositeLegacyId(job.id, area.id) });
        for (const stage of STAGES) {
          const key = STAGE_KEYS[stage];
          templates += liveTemplateEntries(area[key]).length;
          suppressed.archivedTemplates += (Array.isArray(area[key]) ? area[key] : []).filter((t) => t && t.id && t.name && t.archived).length;
        }
      }
    }

    const jobEntry = { jobLegacy: job.id, name: job.name, areas: [], instances: 0 };
    for (const [, { area, areaLegacy }] of liveAreas) {
      const areaEntry = { areaLegacy, areaName: area.name, roughIn: 0, fitOff: 0 };
      for (const stage of STAGES) {
        const overrideList = liveTemplateEntries(area[STAGE_KEYS[stage]]);
        if (overrideList.length) overrides += 1;
        // templateScope tells J3 which job_task_templates row this instance links
        // to: an area override → the area-level template; otherwise the job-level
        // default. This is the override-WINS resolution effectiveEntries applied.
        const templateScope = overrideList.length ? 'area' : 'job';
        for (const entry of effectiveEntries(job, area, stage)) {
          // effectiveEntries only requires a name; a template with no id has no
          // valid legacy_template_id, so J2 would quarantine it. Flag it here too
          // (the gate stays strictly conservative) rather than mint a …|undefined
          // identity. Cannot occur on the current clean data, but the gate exists
          // precisely to catch bad data before J3 writes.
          if (!entry.id) {
            malformed.push({ jobLegacy: job.id, areaLegacy, stage, name: entry.name });
            continue;
          }
          const idKey = `${areaLegacy}|${stage}|${entry.id}`;
          if (seenIdentity.has(idKey)) {
            collisions.push({ jobLegacy: job.id, areaLegacy, stage, templateId: entry.id });
            continue; // a real collision: J3 would violate tasks_area_stage_template_uq
          }
          seenIdentity.add(idKey);

          const recorded = dwellings[area.id] && dwellings[area.id][stage] && dwellings[area.id][stage].tasks
            ? dwellings[area.id][stage].tasks[entry.id]
            : undefined;
          // Status maps ONLY to the schema CHECK set (VALID_TASK_STATES =
          // not_started/in_progress/complete). No recorded state → not_started
          // (the normal unrecorded case). A recorded value OUTSIDE the set (incl.
          // a hypothetical 'blocked', which the tasks.status CHECK forbids) is
          // flagged badStatus → clean=false → the importer ABORTS. Never coerced.
          let status = 'not_started';
          if (VALID_TASK_STATES.includes(recorded)) status = recorded;
          else if (recorded !== undefined && recorded !== null) {
            badStatus.push({ jobLegacy: job.id, areaId: area.id, stage, taskId: entry.id, state: String(recorded) });
          }

          instances.push({
            jobLegacy: job.id,
            areaLegacy,
            stage,
            legacyTemplateId: entry.id, // bare taskId → tasks.legacy_template_id
            name: entry.name,
            status,
            sortOrder: Number.isFinite(entry.order) ? Math.trunc(entry.order) : 0,
            templateScope, // 'job' (default) | 'area' (override) → locates task_template_id
          });
          byStatus[status] += 1;
          byStage[stage] += 1;
          areaEntry[stage] += 1;
          jobEntry.instances += 1;
        }
      }
      jobEntry.areas.push(areaEntry);
    }

    // Orphaned recorded state: a recorded status that maps to NO produced instance.
    for (const areaId of Object.keys(dwellings)) {
      const live = liveAreas.get(areaId);
      if (!live) {
        // state recorded against an area that isn't a live area (archived / unknown)
        for (const stage of STAGES) {
          const tasks = (dwellings[areaId] && dwellings[areaId][stage] && dwellings[areaId][stage].tasks) || {};
          for (const taskId of Object.keys(tasks)) orphanedState.push({ kind: 'state→non-live-area', jobLegacy: job.id, areaId, stage, taskId });
        }
        continue;
      }
      for (const stage of STAGES) {
        const tasks = (dwellings[areaId] && dwellings[areaId][stage] && dwellings[areaId][stage].tasks) || {};
        const effectiveIds = new Set(effectiveEntries(job, live.area, stage).map((t) => t.id));
        for (const taskId of Object.keys(tasks)) {
          if (!effectiveIds.has(taskId)) orphanedState.push({ kind: 'state→no-template', jobLegacy: job.id, areaId, stage, taskId });
        }
      }
    }

    jobs.push(jobEntry);
  }

  const clean =
    collisions.length === 0 && orphanedState.length === 0 && malformed.length === 0 && badStatus.length === 0;
  return {
    clean,
    totals: { templates, instances: instances.length, byStage, byStatus },
    overrides,
    suppressed,
    instances,
    collisions,
    malformed,
    badStatus,
    orphanedState,
    jobs,
    validTaskStates: VALID_TASK_STATES,
  };
}

module.exports = { buildTaskProjection };
