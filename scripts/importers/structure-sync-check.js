#!/usr/bin/env node
// Structure sync-check — the recorded Blob↔Postgres drift check for the place
// structure (jobs + site_area_groups + site_areas). The J1 trust layer, modelled
// on scripts/importers/hours-sync-check.js (#152).
//
//   node scripts/importers/structure-sync-check.js            # dry-run (print only)
//   node scripts/importers/structure-sync-check.js --write     # record into sync_checks
//   node scripts/importers/structure-sync-check.js --json
//
// READ-ONLY against the data (Blob read + a PG read); --write only INSERTs ONE
// append-only row into public.sync_checks (domain 'structure'). NO auto-repair,
// no mutation of jobs/groups/areas. Operator-run, not wired to any route/cron
// (the scheduled cron is J6).
//
// The Blob side is projected via buildStructureRows — the SAME builder the
// importer writes from — so a clean import is IN SYNC by construction. The PG
// side is read with matching field shapes; only the archive STATE (deleted bool)
// is compared, never the proxy deleted_at timestamp.

const { buildStructureRows } = require('./lib/structure-rows');
const { buildTaskProjection } = require('./lib/task-projection');
const { buildEvidenceRows } = require('./lib/evidence-rows');
const { buildStructureSyncReport } = require('../../api/_lib/structure-sync-report');
const { getDb, closeDb } = require('../../api/_lib/supabase-db');

const DATA_CONCURRENCY = 8;

function parseArgs(argv) {
  const args = { write: false, json: false, help: false };
  for (const a of argv) {
    if (a === '--write') args.write = true;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else { console.error(`unknown argument: ${a}`); args.help = true; }
  }
  return args;
}

const STRUCTURE_TABLES = new Set(['jobs', 'site_area_groups', 'site_areas', 'job_task_templates']);

// Template business key = the full partial-index tuple [job, area|null, stage,
// legacy_id], so job-level and area-override rows that share a bare taskId stay
// distinct and both sides agree. The importer writes only name/sort_order/deleted
// — required_photo_count/requires_note/is_active/description are PG-owned and
// DELIBERATELY excluded (else an admin's later evidence-requirement authoring
// would manufacture false drift).
function templateKey(jobLegacy, areaLegacy, stage, legacyId) {
  return JSON.stringify([jobLegacy, areaLegacy ?? null, stage, legacyId]);
}
// Task business key = the tasks_area_stage_template_uq bridge [area, stage,
// legacy_template_id]. The importer writes name/status/sort_order (+ identity);
// task_template_id is compared only as a presence boolean (templateLinked) — the
// uuid itself is a resolved FK, not a blob-mirrored value (like deleted_by).
function taskKey(areaLegacy, stage, legacyTemplateId) {
  return JSON.stringify([areaLegacy, stage, legacyTemplateId]);
}

// Blob projection — derived from the importer's own row builder so the check can
// never drift from what the importer writes. Entities carry only stable fields
// (no uuid/revision/timestamps); the archive dimension is a `deleted` boolean.
function projectBlob(sources, nowIso) {
  const built = buildStructureRows(sources, { nowIso });
  // Compare EVERY mutable job column the importer writes (JOB_MUTABLE_COLS) so
  // there is no blind spot — an omitted field would let PG diverge undetected.
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
  // Tasks: from the SHARED projection engine (the same expansion the importer
  // writes). Compare importer-written fields (name/status/sort_order) + identity;
  // task_template_id as a presence boolean only.
  const proj = buildTaskProjection(sources);
  const tasks = proj.instances.map((i) => ({
    key: taskKey(i.areaLegacy, i.stage, i.legacyTemplateId),
    job_legacy_id: i.jobLegacy, site_area_legacy_id: i.areaLegacy,
    stage: i.stage, legacy_template_id: i.legacyTemplateId, name: i.name,
    // template_linked is an importer PROMISE, not blob data: every expansion
    // instance resolves task_template_id at write-time (fail-closed), so the blob
    // side is always true. The PG side reads (task_template_id is not null) — a
    // mismatch catches a task whose template FK didn't resolve. The uuid itself is
    // a resolved FK (excluded from the comparison, like deleted_by).
    status: i.status, sort_order: i.sortOrder, template_linked: true,
  }));
  // Anything the importer would quarantine (and abort on) is, for the check, a
  // blob entity that cannot be mapped to a comparable PG key.
  const unmappable = built.quarantine
    .filter((q) => STRUCTURE_TABLES.has(q.table))
    .map((q) => `${q.table}:${q.id} (${q.reason})`);
  // A non-clean task projection (collision/malformed/bad-status/orphaned) is an
  // unmappable condition too — it forces FAIL rather than silently dropping rows.
  if (!proj.clean) {
    for (const c of proj.collisions) unmappable.push(`tasks:collision ${c.areaLegacy}|${c.stage}|${c.templateId}`);
    for (const m of proj.malformed) unmappable.push(`tasks:malformed ${m.jobLegacy}/${m.stage}/${m.name}`);
    for (const b of proj.badStatus) unmappable.push(`tasks:badstatus ${b.areaId}/${b.stage}/${b.taskId}=${b.state}`);
    for (const o of proj.orphanedState) unmappable.push(`tasks:orphaned ${o.kind} ${o.areaId}/${o.stage}/${o.taskId}`);
  }
  return { jobs, groups, areas, templates, tasks, unmappable };
}

async function readPg(sql, tenantId) {
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
  // Templates: resolve job/area legacy via joins; build the composite key in JS.
  // Select ONLY the importer-written fields (name/sort_order/deleted) + identity —
  // never the PG-owned required_photo_count/requires_note/is_active/description.
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
  // Tasks: resolve job/area legacy via joins; build the bridge key in JS. Select
  // ONLY importer-written fields (name/status/sort_order) + identity + a
  // template-linked presence boolean (task_template_id uuid itself is excluded).
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
  // postgres.js returns query results as array-likes; normalise to plain arrays.
  return { jobs: [...jobs], groups: [...groups], areas: [...areas], templates, tasks };
}

// Records ONE append-only row in public.sync_checks (domain 'structure'). The
// scalar columns are hours-shaped, so for the structure domain we reuse them
// honestly: blob_total/pg_total carry the archived/deleted entity counts, and
// allocations_checked is false (structure has no allocation concept). The
// authoritative per-section breakdown (jobs/groups/areas + drift lists) lives in
// `details`. mismatched is the true field-mismatch count; unmappable lives in
// details and still forces status='fail'.
async function recordCheck(sql, tenantId, report, durationMs) {
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

async function loadBlob() {
  const { readBlob } = require('../../api/_lib/blob');
  const jobs = await readBlob('jobs.json', null);
  // Per-job data.json (task state) — needed for the tasks-section projection.
  const jobData = {};
  const ids = (jobs && Array.isArray(jobs.jobs) ? jobs.jobs : []).filter((j) => j && j.id).map((j) => j.id);
  for (let i = 0; i < ids.length; i += DATA_CONCURRENCY) {
    const chunk = ids.slice(i, i + DATA_CONCURRENCY);
    const results = await Promise.all(chunk.map((id) => readBlob(`jobs/${id}/data.json`, null)));
    chunk.forEach((id, idx) => { jobData[id] = results[idx]; });
  }
  return { jobs, jobData };
}

// FK maps for the evidence blob projection (the coordinate→task resolution lives
// in the shared proof-projection, used by buildEvidenceRows — no duplicate logic).
async function evidenceMaps(sql, tenantId) {
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

// Evidence + proof sections, projected from the SAME builder the importer writes.
// Compares importer-written semantic fields + granularity + FK-presence booleans;
// excludes the uuid FKs (site_area_id/task_id/captured_by) and the capture/review
// TIMESTAMPS (metadata; cross-store precision) — same rule as the other sections.
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/importers/structure-sync-check.js [--write] [--json]');
    return;
  }

  const startedAt = Date.now();
  let report;
  try {
    const sql = getDb({ mode: args.write ? 'write' : 'read' });
    const tenant = await sql`select id from public.tenants where slug = 'buhl'`;
    if (!tenant.length) throw new Error('no tenant (slug "buhl") — run structure-import.js --write first');
    const tenantId = tenant[0].id;

    const sources = await loadBlob();
    const blob = projectBlob(sources, new Date().toISOString());
    const pg = await readPg(sql, tenantId);
    // J4: evidence + proof sections (need FK maps; reuse the shared builder).
    const maps = await evidenceMaps(sql, tenantId);
    const ev = projectEvidence(sources, { tenantId, ...maps });
    blob.evidence = ev.evidence;
    blob.proof = ev.proof;
    blob.unmappable = [...blob.unmappable, ...ev.unmappable];
    const pgEv = await readPgEvidence(sql, tenantId);
    pg.evidence = pgEv.evidence;
    pg.proof = pgEv.proof;
    report = buildStructureSyncReport({ blob, pg });
    const durationMs = Date.now() - startedAt;
    report.durationMs = durationMs;
    if (args.write) {
      await recordCheck(sql, tenantId, report, durationMs);
      report.recorded = true;
    }
  } finally {
    await closeDb();
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nStructure sync-check — ${report.status === 'pass' ? 'IN SYNC ✓' : 'DRIFT — FAIL'}`);
    console.log(`Blob:     ${report.blobCount} entities (${report.blobDeleted} archived)  hash ${String(report.blobHash).slice(0, 12)}…`);
    console.log(`Postgres: ${report.pgCount} entities (${report.pgDeleted} deleted)  hash ${String(report.pgHash).slice(0, 12)}…`);
    for (const [name, s] of Object.entries(report.details.sections)) {
      console.log(`  ${name.padEnd(7)} blob ${s.blobCount} · pg ${s.pgCount} · matched ${s.matched} · only-blob ${s.onlyInBlobCount} · only-pg ${s.onlyInPgCount} · mismatched ${s.mismatchedCount}`);
    }
    console.log(`unmappable ${report.unmappableCount} · hashMatch ${report.details.hashMatch}`);
    if (report.status !== 'pass') console.log(`details: ${JSON.stringify(report.details)}`);
    console.log(`checked in ${report.durationMs}ms${report.recorded ? ' · recorded to sync_checks' : ' (dry-run — use --write to record)'}`);
  }
  process.exitCode = 0;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
