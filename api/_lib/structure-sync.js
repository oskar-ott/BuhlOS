// Structure sync-check core (#152 trust layer) — the ONE implementation of the
// recorded Blob↔Postgres drift check for the place structure + tasks + evidence
// (jobs / site_area_groups / site_areas / job_task_templates / tasks /
// evidence_files / evidence_links), shared by the manual operator runner
// (scripts/importers/structure-sync-check.js) and the scheduled cron route
// (api/internal/sync-checks/structure.js). Extracted verbatim from the runner so
// the two can never diverge — the hours-sync.js pattern, applied to structure.
//
// READ-ONLY against domain data: it reads jobs.json + per-job data.json and the
// mirrored PG rows, then (only when asked) INSERTs ONE append-only row into
// public.sync_checks (domain 'structure'). It never writes, repairs or deletes
// jobs/groups/areas/tasks/evidence — drift is reported, never silently "fixed".
//
// The Blob side is projected via the importer's OWN builders (buildStructureRows
// / buildTaskProjection / buildEvidenceRows) so a clean import is IN SYNC by
// construction. Connection lifecycle is the CALLER's: the CLI opens + closeDb()s;
// the serverless cron reuses the warm singleton.

const { buildStructureRows } = require('../../scripts/importers/lib/structure-rows');
const { buildTaskProjection } = require('../../scripts/importers/lib/task-projection');
const { buildEvidenceRows } = require('../../scripts/importers/lib/evidence-rows');
const { buildStructureSyncReport } = require('./structure-sync-report');

const DATA_CONCURRENCY = 8;
const STRUCTURE_TABLES = new Set(['jobs', 'site_area_groups', 'site_areas', 'job_task_templates']);

// Template business key = the full partial-index tuple [job, area|null, stage,
// legacy_id]; task business key = the tasks_area_stage_template_uq bridge
// [area, stage, legacy_template_id]. (Kept identical to the importer/runner.)
function templateKey(jobLegacy, areaLegacy, stage, legacyId) {
  return JSON.stringify([jobLegacy, areaLegacy ?? null, stage, legacyId]);
}
function taskKey(areaLegacy, stage, legacyTemplateId) {
  return JSON.stringify([areaLegacy, stage, legacyTemplateId]);
}

// List jobs.json + every per-job data.json (task state) for the tasks projection.
async function loadBlobStructure(deps = {}) {
  const { readBlob = require('./blob').readBlob } = deps;
  const jobs = await readBlob('jobs.json', null);
  const jobData = {};
  const ids = (jobs && Array.isArray(jobs.jobs) ? jobs.jobs : []).filter((j) => j && j.id).map((j) => j.id);
  for (let i = 0; i < ids.length; i += DATA_CONCURRENCY) {
    const chunk = ids.slice(i, i + DATA_CONCURRENCY);
    const results = await Promise.all(chunk.map((id) => readBlob(`jobs/${id}/data.json`, null)));
    chunk.forEach((id, idx) => { jobData[id] = results[idx]; });
  }
  return { jobs, jobData };
}

// Blob projection — derived from the importer's own row builders so the check can
// never drift from what the importer writes (verbatim from the operator runner).
function projectBlob(sources, nowIso) {
  const built = buildStructureRows(sources, { nowIso });
  const jobs = built.jobRows.map((r) => ({
    key: r.legacy_id, name: r.name, status: r.status, ref: r.ref,
    job_type_label: r.job_type_label, external_ref: r.external_ref,
    site_address: r.site_address,
    site_contact_name: r.site_contact_name, site_contact_phone: r.site_contact_phone,
    access_notes: r.access_notes, parking_notes: r.parking_notes, safety_notes: r.safety_notes,
    induction_required: r.induction_required,
    start_date: r.start_date, due_date: r.due_date,
    programmed_duration_days: r.programmed_duration_days, deleted: false,
  }));
  const groups = built.groupRows.map((r) => ({
    key: r.legacy_id, job_legacy_id: r.job_legacy_id, name: r.name,
    sort_order: r.sort_order, deleted: r.deleted_at !== null,
  }));
  const areas = built.areaRows.map((r) => ({
    key: r.legacy_id, job_legacy_id: r.job_legacy_id, group_legacy_id: r.group_legacy_id,
    name: r.name, space_type: r.space_type, sort_order: r.sort_order, deleted: r.deleted_at !== null,
  }));
  const templates = built.templateRows.map((r) => ({
    key: templateKey(r.job_legacy_id, r.site_area_legacy_id, r.stage, r.legacy_id),
    job_legacy_id: r.job_legacy_id, site_area_legacy_id: r.site_area_legacy_id,
    stage: r.stage, legacy_id: r.legacy_id, name: r.name, sort_order: r.sort_order,
    deleted: r.deleted_at !== null,
  }));
  const proj = buildTaskProjection(sources);
  const tasks = proj.instances.map((i) => ({
    key: taskKey(i.areaLegacy, i.stage, i.legacyTemplateId),
    job_legacy_id: i.jobLegacy, site_area_legacy_id: i.areaLegacy,
    stage: i.stage, legacy_template_id: i.legacyTemplateId, name: i.name,
    status: i.status, sort_order: i.sortOrder, template_linked: true,
  }));
  const unmappable = built.quarantine
    .filter((q) => STRUCTURE_TABLES.has(q.table))
    .map((q) => `${q.table}:${q.id} (${q.reason})`);
  if (!proj.clean) {
    for (const c of proj.collisions) unmappable.push(`tasks:collision ${c.areaLegacy}|${c.stage}|${c.templateId}`);
    for (const m of proj.malformed) unmappable.push(`tasks:malformed ${m.jobLegacy}/${m.stage}/${m.name}`);
    for (const b of proj.badStatus) unmappable.push(`tasks:badstatus ${b.areaId}/${b.stage}/${b.taskId}=${b.state}`);
    for (const o of proj.orphanedState) unmappable.push(`tasks:orphaned ${o.kind} ${o.areaId}/${o.stage}/${o.taskId}`);
  }
  return { jobs, groups, areas, templates, tasks, unmappable };
}

async function readPgStructure(sql, tenantId) {
  const jobs = await sql`
    select legacy_id as key, name, status, ref, job_type_label, external_ref,
           site_address, site_contact_name, site_contact_phone,
           access_notes, parking_notes, safety_notes, induction_required,
           start_date::text as start_date, due_date::text as due_date,
           programmed_duration_days, (deleted_at is not null) as deleted
    from public.jobs
    where tenant_id = ${tenantId} and legacy_id is not null
  `;
  const groups = await sql`
    select g.legacy_id as key, jb.legacy_id as job_legacy_id, g.name, g.sort_order,
           (g.deleted_at is not null) as deleted
    from public.site_area_groups g
    left join public.jobs jb on jb.id = g.job_id
    where g.tenant_id = ${tenantId} and g.legacy_id is not null
  `;
  const areas = await sql`
    select a.legacy_id as key, jb.legacy_id as job_legacy_id, gp.legacy_id as group_legacy_id,
           a.name, a.space_type, a.sort_order, (a.deleted_at is not null) as deleted
    from public.site_areas a
    left join public.jobs jb on jb.id = a.job_id
    left join public.site_area_groups gp on gp.id = a.group_id
    where a.tenant_id = ${tenantId} and a.legacy_id is not null
  `;
  const tplRaw = await sql`
    select jb.legacy_id as job_legacy_id, ar.legacy_id as site_area_legacy_id,
           t.stage, t.legacy_id, t.name, t.sort_order, (t.deleted_at is not null) as deleted
    from public.job_task_templates t
    left join public.jobs jb on jb.id = t.job_id
    left join public.site_areas ar on ar.id = t.site_area_id
    where t.tenant_id = ${tenantId} and t.legacy_id is not null
  `;
  const templates = [...tplRaw].map((r) => ({
    key: templateKey(r.job_legacy_id, r.site_area_legacy_id, r.stage, r.legacy_id),
    job_legacy_id: r.job_legacy_id, site_area_legacy_id: r.site_area_legacy_id,
    stage: r.stage, legacy_id: r.legacy_id, name: r.name, sort_order: r.sort_order,
    deleted: r.deleted,
  }));
  const taskRaw = await sql`
    select jb.legacy_id as job_legacy_id, ar.legacy_id as site_area_legacy_id,
           t.stage, t.legacy_template_id, t.name, t.status, t.sort_order,
           (t.task_template_id is not null) as template_linked
    from public.tasks t
    left join public.jobs jb on jb.id = t.job_id
    left join public.site_areas ar on ar.id = t.site_area_id
    where t.tenant_id = ${tenantId} and t.legacy_template_id is not null and t.deleted_at is null
  `;
  const tasks = [...taskRaw].map((r) => ({
    key: taskKey(r.site_area_legacy_id, r.stage, r.legacy_template_id),
    job_legacy_id: r.job_legacy_id, site_area_legacy_id: r.site_area_legacy_id,
    stage: r.stage, legacy_template_id: r.legacy_template_id, name: r.name,
    status: r.status, sort_order: r.sort_order, template_linked: r.template_linked,
  }));
  return { jobs: [...jobs], groups: [...groups], areas: [...areas], templates, tasks };
}

async function recordStructureSyncCheck(sql, tenantId, report, durationMs) {
  await sql`
    insert into public.sync_checks
      (tenant_id, domain, status, blob_count, pg_count, blob_total, pg_total,
       allocations_checked, matched, only_in_blob, only_in_pg, mismatched,
       blob_hash, pg_hash, details, duration_ms)
    values
      (${tenantId}, 'structure', ${report.status}, ${report.blobCount}, ${report.pgCount},
       ${report.blobDeleted}, ${report.pgDeleted}, false, ${report.matched},
       ${report.onlyInBlobCount}, ${report.onlyInPgCount}, ${report.mismatchedCount},
       ${report.blobHash}, ${report.pgHash}, ${sql.json(report.details)}, ${durationMs})
  `;
}

// FK maps for the evidence blob projection (coordinate→task resolution lives in
// the shared proof-projection used by buildEvidenceRows — no duplicate logic).
async function loadEvidenceMaps(sql, tenantId) {
  const m = async (table, col) => {
    const rows = await sql`select id, ${sql(col)} as legacy from ${sql(table)} where tenant_id = ${tenantId} and ${sql(col)} is not null`;
    return new Map(rows.map((r) => [r.legacy, r.id]));
  };
  const jobMap = await m('jobs', 'legacy_id');
  const areaMap = await m('site_areas', 'legacy_id');
  const userMap = await m('user_profiles', 'legacy_user_id');
  const taskRows = await sql`
    select t.id, ar.legacy_id as area_legacy, t.stage, t.legacy_template_id
    from public.tasks t join public.site_areas ar on ar.id = t.site_area_id
    where t.tenant_id = ${tenantId} and t.site_area_id is not null and t.legacy_template_id is not null
  `;
  const taskMap = new Map(taskRows.map((r) => [`${r.area_legacy}|${r.stage}|${r.legacy_template_id}`, r.id]));
  return { jobMap, areaMap, userMap, taskMap };
}

function projectEvidence(sources, ctx) {
  const built = buildEvidenceRows(sources, ctx);
  const evidence = built.evidenceRows.map((r) => ({
    key: r.legacy_id, kind: r.kind, status: r.status, source: r.source, note: r.note,
    blob_url: r.blob_url, photo_blob_id: r.photo_blob_id, thumbnail_url: r.thumbnail_url, stage: r.stage,
    captured_by_label: r.captured_by_label, reviewed_by_label: r.reviewed_by_label, rejection_reason: r.rejection_reason,
    exif_lat: r.exif_lat, exif_lng: r.exif_lng,
    has_area: r.site_area_id !== null, has_task: r.task_id !== null,
    granularity: r.task_id ? 'task' : (r.site_area_id ? 'area' : 'job'),
  }));
  const proof = built.evidenceRows
    .filter((r) => r.task_id)
    .map((r) => ({ key: `${r.legacy_id}|task|proof`, evidence_legacy_id: r.legacy_id, link_role: 'proof', task_id: r.task_id }));
  const unmappable = built.quarantine.map((q) => `evidence:${q.id} (${q.reason})`);
  return { evidence, proof, unmappable };
}

async function readPgEvidence(sql, tenantId) {
  const ef = await sql`
    select legacy_id as key, kind, status, source, note, blob_url, photo_blob_id, thumbnail_url, stage,
           captured_by_label, reviewed_by_label, rejection_reason, exif_lat, exif_lng,
           (site_area_id is not null) as has_area, (task_id is not null) as has_task
    from public.evidence_files
    where tenant_id = ${tenantId} and legacy_id is not null and deleted_at is null
  `;
  const evidence = [...ef].map((r) => ({ ...r, granularity: r.has_task ? 'task' : (r.has_area ? 'area' : 'job') }));
  const links = await sql`
    select ef.legacy_id as evidence_legacy_id, el.linked_entity_id as task_id, el.link_role
    from public.evidence_links el join public.evidence_files ef on ef.id = el.evidence_file_id
    where el.tenant_id = ${tenantId} and el.linked_entity_type = 'task'
  `;
  const proof = [...links].map((r) => ({ key: `${r.evidence_legacy_id}|task|${r.link_role}`, evidence_legacy_id: r.evidence_legacy_id, link_role: r.link_role, task_id: r.task_id }));
  return { evidence, proof };
}

/**
 * Resolve tenant, load both sides (structure + evidence), build the report,
 * optionally record it. Pure orchestration over injectable I/O (`deps`) — the
 * connection lifecycle and env/flag gating are the CALLER's job. Returns the
 * report (durationMs always set; `recorded: true` when persisted).
 *
 * @param {any} sql  Postgres.js tagged-template client (already guarded/opened)
 * @param {{ record?: boolean, deps?: object }} [options]
 */
async function runStructureSyncCheck(sql, { record = false, deps = {} } = {}) {
  const {
    loadBlob = loadBlobStructure,
    readPg = readPgStructure,
    evidenceMaps = loadEvidenceMaps,
    readEvidence = readPgEvidence,
    buildReport = buildStructureSyncReport,
    recordCheck = recordStructureSyncCheck,
    now = Date.now,
    nowIso = () => new Date(now()).toISOString(),
  } = deps;

  const startedAt = now();
  const tenant = await sql`select id from public.tenants where slug = 'buhl'`;
  if (!tenant.length) throw new Error('no tenant (slug "buhl") — run structure-import.js --write first');
  const tenantId = tenant[0].id;

  const sources = await loadBlob();
  const blob = projectBlob(sources, nowIso());
  const pg = await readPg(sql, tenantId);
  const maps = await evidenceMaps(sql, tenantId);
  const ev = projectEvidence(sources, { tenantId, ...maps });
  blob.evidence = ev.evidence;
  blob.proof = ev.proof;
  blob.unmappable = [...blob.unmappable, ...ev.unmappable];
  const pgEv = await readEvidence(sql, tenantId);
  pg.evidence = pgEv.evidence;
  pg.proof = pgEv.proof;

  const report = buildReport({ blob, pg });
  report.durationMs = now() - startedAt;
  if (record) {
    await recordCheck(sql, tenantId, report, report.durationMs);
    report.recorded = true;
  }
  return report;
}

module.exports = {
  loadBlobStructure, projectBlob, readPgStructure, recordStructureSyncCheck,
  loadEvidenceMaps, projectEvidence, readPgEvidence, runStructureSyncCheck,
  templateKey, taskKey,
};
