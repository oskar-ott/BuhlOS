// Structure dry-run planner — PURE. No I/O, no Supabase, no Blob.
//
// Input: parsed legacy sources (users.json, jobs.json, per-job data.json).
// Output: a plan object — proposed per-table insert counts for the Phase 1
// structure slice (tenant → user_profiles → jobs → job_members →
// site_area_groups → site_areas → job_task_templates → tasks), plus the
// validation buckets the importer contract requires: hard errors, warnings,
// quarantined missing references, duplicate legacy ids, invalid records.
//
// Rules mirrored from production code (NOT reinvented):
//   * task override resolution = api/_lib/job-tasks.js — a non-empty
//     area-level list wins, an EMPTY array means "use the job default",
//     archived entries are excluded from effective lists
//   * structure walk shape = api/_lib/job-duplicate.js
//   * value lists = the schema CHECKs in
//     supabase/migrations/20260611142758_phase1_core_schema.sql
//
// Unknown roles/statuses are NOT guessed at: they quarantine the record and
// fail the run, so the real importer gets an explicit normalisation map
// (e.g. legacy "leading hand" spellings) instead of silent coercion.
// Contract: docs/supabase-importer-plan.md.

const VALID_USER_ROLES = [
  'admin', 'boss', 'owner', 'manager', 'office', 'pm', 'estimator',
  'leadinghand', 'tradie', 'apprentice', 'labourer', 'electrician', 'client',
];
const VALID_JOB_STATUSES = ['draft', 'active', 'on_hold', 'complete', 'archived'];
const VALID_TASK_STATES = ['not_started', 'in_progress', 'complete'];
const STAGES = ['roughIn', 'fitOff'];
const STAGE_KEYS = { roughIn: 'roughInTasks', fitOff: 'fitOffTasks' };
const LEAD_ROLES = ['leadinghand'];

function emptyTable() {
  return { inserts: 0, updates: 0 };
}

// Live template entries for effective-checklist purposes (job-duplicate rule:
// must have a name, must not be archived).
function liveEntries(list) {
  return (Array.isArray(list) ? list : []).filter((t) => t && t.name && !t.archived);
}

// api/_lib/job-tasks.js rule: non-empty override wins; empty/missing → default.
function effectiveEntries(job, area, stage) {
  const key = STAGE_KEYS[stage];
  const override = area && Array.isArray(area[key]) ? liveEntries(area[key]) : [];
  if (override.length) return override;
  return liveEntries(job ? job[key] : []);
}

function buildStructureImportPlan(sources) {
  const users = sources && sources.users;
  const jobs = sources && sources.jobs;
  const jobData = (sources && sources.jobData) || {};

  const plan = {
    tables: {
      tenants: { inserts: 1, updates: 0 },
      user_profiles: emptyTable(),
      jobs: emptyTable(),
      job_members: emptyTable(),
      site_area_groups: emptyTable(),
      site_areas: emptyTable(),
      job_task_templates: emptyTable(),
      tasks: emptyTable(),
    },
    hardErrors: [],
    warnings: [],
    missingRefs: [],
    duplicateLegacyIds: [],
    invalidRecords: [],
    summary: {
      sources: { users: 0, jobs: 0, jobDataBlobs: 0 },
      members: { total: 0, leads: 0 },
      archived: { groups: 0, areas: 0, templateEntries: 0 },
      taskStates: { complete: 0, in_progress: 0, unknown: 0 },
      distinctJobStatuses: {},
      // Target is known-empty (fresh Phase 1 schema). A re-run against a
      // populated target would match on legacy_id and report updates here.
      updatesNote: 'target known-empty; idempotent re-runs match on legacy_id',
      clean: false,
    },
  };

  const userList = users && Array.isArray(users.users) ? users.users : null;
  const jobList = jobs && Array.isArray(jobs.jobs) ? jobs.jobs : null;
  if (!userList) plan.hardErrors.push('users.json missing or not of shape { users: [] }');
  if (!jobList) plan.hardErrors.push('jobs.json missing or not of shape { jobs: [] }');

  // ── jobs (first: members/state resolve against the job id set) ───────────
  const jobIds = new Set();
  const liveAreaIdsByJob = new Map(); // jobId → Map(areaId → area)
  for (const job of jobList || []) {
    plan.summary.sources.jobs += 1;
    if (!job || !job.id || !job.name) {
      plan.invalidRecords.push({
        kind: 'job',
        id: (job && job.id) || '(missing id)',
        reason: 'job requires id and name',
      });
      continue;
    }
    if (jobIds.has(job.id)) {
      plan.duplicateLegacyIds.push({ table: 'jobs', legacyId: job.id });
      continue;
    }
    jobIds.add(job.id);
    const status = job.status || 'draft';
    plan.summary.distinctJobStatuses[status] =
      (plan.summary.distinctJobStatuses[status] || 0) + 1;
    if (!VALID_JOB_STATUSES.includes(status)) {
      plan.invalidRecords.push({
        kind: 'job',
        id: job.id,
        reason: `status "${status}" fails the schema CHECK (${VALID_JOB_STATUSES.join('/')}) — needs an explicit mapping`,
      });
      continue;
    }
    plan.tables.jobs.inserts += 1;

    // groups → areas → template entries
    const liveAreas = new Map();
    for (const group of Array.isArray(job.areaGroups) ? job.areaGroups : []) {
      if (!group || !group.id || !group.name) {
        plan.invalidRecords.push({
          kind: 'site_area_group',
          id: (group && group.id) || `(job ${job.id})`,
          reason: 'group requires id and name',
        });
        continue;
      }
      if (seenOnce(plan, 'site_area_groups', group.id)) continue;
      plan.tables.site_area_groups.inserts += 1;
      if (group.archived) plan.summary.archived.groups += 1;

      for (const area of Array.isArray(group.areas) ? group.areas : []) {
        if (!area || !area.id || !area.name) {
          plan.invalidRecords.push({
            kind: 'site_area',
            id: (area && area.id) || `(group ${group.id})`,
            reason: 'area requires id and name',
          });
          continue;
        }
        if (seenOnce(plan, 'site_areas', area.id)) continue;
        plan.tables.site_areas.inserts += 1;
        if (area.archived) {
          plan.summary.archived.areas += 1;
        } else {
          liveAreas.set(area.id, area);
        }
        // area-level template overrides (non-empty only — empty = default)
        for (const stage of STAGES) {
          const entries = Array.isArray(area[STAGE_KEYS[stage]]) ? area[STAGE_KEYS[stage]] : [];
          countTemplateEntries(plan, entries, { scope: `area ${area.id}`, stage });
        }
      }
    }
    liveAreaIdsByJob.set(job.id, liveAreas);

    // job-level default template lists
    for (const stage of STAGES) {
      const entries = Array.isArray(job[STAGE_KEYS[stage]]) ? job[STAGE_KEYS[stage]] : [];
      countTemplateEntries(plan, entries, { scope: `job ${job.id}`, stage });
    }
  }

  // ── users + job_members ──────────────────────────────────────────────────
  const userIds = new Set();
  for (const user of userList || []) {
    plan.summary.sources.users += 1;
    if (!user || !user.id || !(user.username || user.name)) {
      plan.invalidRecords.push({
        kind: 'user',
        id: (user && user.id) || '(missing id)',
        reason: 'user requires id and username/name',
      });
      continue;
    }
    if (userIds.has(user.id)) {
      plan.duplicateLegacyIds.push({ table: 'user_profiles', legacyId: user.id });
      continue;
    }
    userIds.add(user.id);
    if (!VALID_USER_ROLES.includes(user.role)) {
      plan.invalidRecords.push({
        kind: 'user',
        id: user.id,
        reason: `role "${user.role}" fails the schema CHECK — needs an explicit normalisation mapping (no guessing)`,
      });
      continue;
    }
    plan.tables.user_profiles.inserts += 1;

    for (const jobId of Array.isArray(user.assignedJobIds) ? user.assignedJobIds : []) {
      if (!jobIds.has(jobId)) {
        plan.missingRefs.push({ kind: 'job_member→job', from: user.id, ref: jobId });
        continue;
      }
      plan.tables.job_members.inserts += 1;
      plan.summary.members.total += 1;
      if (LEAD_ROLES.includes(user.role)) plan.summary.members.leads += 1;
    }
  }

  // ── tasks (execution instances) from structure × recorded state ─────────
  for (const job of jobList || []) {
    if (!job || !job.id || !jobIds.has(job.id)) continue;
    // jobs quarantined after id registration (e.g. invalid status) never
    // reach the structure walk — skip their state too, they're already
    // reported once as invalid records.
    const liveAreas = liveAreaIdsByJob.get(job.id);
    if (!liveAreas) continue;
    const data = jobData[job.id];
    if (data !== undefined && data !== null) plan.summary.sources.jobDataBlobs += 1;
    const dwellings = (data && data.dwellings) || {};

    // proposed task rows: one per effective template entry per LIVE area+stage
    for (const [, area] of liveAreas) {
      for (const stage of STAGES) {
        plan.tables.tasks.inserts += effectiveEntries(job, area, stage).length;
      }
    }

    // recorded state must resolve to a live area and an effective entry
    for (const areaId of Object.keys(dwellings)) {
      const area = liveAreas.get(areaId);
      if (!area) {
        plan.missingRefs.push({ kind: 'task_state→area', from: `job ${job.id}`, ref: areaId });
        continue;
      }
      for (const stage of STAGES) {
        const stageState = dwellings[areaId] && dwellings[areaId][stage];
        const stateMap = (stageState && stageState.tasks) || {};
        const effectiveIds = new Set(effectiveEntries(job, area, stage).map((t) => t.id));
        for (const [taskId, state] of Object.entries(stateMap)) {
          if (!effectiveIds.has(taskId)) {
            plan.missingRefs.push({
              kind: 'task_state→template',
              from: `area ${areaId} ${stage}`,
              ref: taskId,
            });
            continue;
          }
          if (state === 'complete') plan.summary.taskStates.complete += 1;
          else if (state === 'in_progress') plan.summary.taskStates.in_progress += 1;
          else if (VALID_TASK_STATES.includes(state)) {
            // not_started recorded explicitly — fine, no count needed
          } else {
            plan.summary.taskStates.unknown += 1;
            plan.warnings.push(
              `unknown task state "${state}" on ${areaId}/${stage}/${taskId} — would import as not_started, flagged`
            );
          }
        }
      }
    }
  }

  plan.summary.clean =
    plan.hardErrors.length === 0 &&
    plan.invalidRecords.length === 0 &&
    plan.duplicateLegacyIds.length === 0;
  return plan;
}

// Template-entry counter with schema-scoped duplicate detection:
// job-level uniqueness is (job, stage, legacy_id); area-level is
// (area, stage, legacy_id) — mirrors the partial unique indexes.
const _templateSeen = Symbol('templateSeen');
function countTemplateEntries(plan, entries, { scope, stage }) {
  if (!plan[_templateSeen]) plan[_templateSeen] = new Set();
  for (const entry of entries) {
    if (!entry || !entry.id || !entry.name) {
      plan.invalidRecords.push({
        kind: 'job_task_template',
        id: (entry && entry.id) || `(${scope} ${stage})`,
        reason: 'template entry requires id and name',
      });
      continue;
    }
    const key = `${scope}|${stage}|${entry.id}`;
    if (plan[_templateSeen].has(key)) {
      plan.duplicateLegacyIds.push({ table: 'job_task_templates', legacyId: key });
      continue;
    }
    plan[_templateSeen].add(key);
    plan.tables.job_task_templates.inserts += 1;
    if (entry.archived) plan.summary.archived.templateEntries += 1;
  }
}

// Global (tenant-wide) legacy uniqueness for groups/areas — matches the
// schema's (tenant_id, legacy_id) partial uniques. Returns true on duplicate.
const _globalSeen = Symbol('globalSeen');
function seenOnce(plan, table, legacyId) {
  if (!plan[_globalSeen]) plan[_globalSeen] = new Map();
  if (!plan[_globalSeen].has(table)) plan[_globalSeen].set(table, new Set());
  const set = plan[_globalSeen].get(table);
  if (set.has(legacyId)) {
    plan.duplicateLegacyIds.push({ table, legacyId });
    return true;
  }
  set.add(legacyId);
  return false;
}

module.exports = {
  buildStructureImportPlan,
  effectiveEntries,
  VALID_USER_ROLES,
  VALID_JOB_STATUSES,
  VALID_TASK_STATES,
  STAGES,
};
