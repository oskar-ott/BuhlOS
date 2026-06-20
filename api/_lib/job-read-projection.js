// J5 — DARK Postgres read projection for jobs/tasks. Reconstructs the legacy
// Blob/job shape (jobs.json job + per-job data.json: dwellings, evidence) FROM the
// canonical Postgres graph (jobs → site_area_groups → site_areas →
// job_task_templates → tasks → task_status_events* → evidence_files), so a reader
// could be served from Postgres instead of Blob.
//
// *task_status_events is the audit history, not part of the current-state read.
//
// DARK + SAFE BY DEFAULT: nothing in the app consumes this yet. readJobsFromPgIfEnabled
// is gated behind the `supabase_read_jobs` flag (default OFF) and is best-effort —
// any error returns { pg:false } so the caller falls back to Blob, which stays
// AUTHORITATIVE. No write path; no route/UI cutover (that is a later rung).
//
// The reconstruction reverses the importer mappings exactly (composite area/group
// legacy_id → blob id via decomposeLegacyId; bare legacy_template_id → blob taskId;
// uuid FKs → legacy ids via joins; *_label preserved where the actor uuid is null),
// so feeding the reconstruction back through the importers' Blob projections yields
// the SAME migrated entities as the real Blob — the J5 parity proof
// (scripts/importers/job-read-parity.js).

const { decomposeLegacyId } = require('../../scripts/importers/lib/structure-legacy-id');

const STAGE_KEYS = { roughIn: 'roughInTasks', fitOff: 'fitOffTasks' };

function localId(legacy) {
  const d = decomposeLegacyId(legacy);
  return d ? d.localId : legacy; // jobs keep raw ids; groups/areas are composite
}
function emptyStageLists() {
  return { roughInTasks: [], fitOffTasks: [] };
}

/**
 * Reconstruct the Blob sources shape from flat PG rows (each carrying its own
 * legacy id + parent legacy ids resolved by the loader's joins). PURE.
 * @returns {{ jobs: { jobs: object[] }, jobData: Record<string, object> }}
 */
function reconstructFromPg(rows = {}) {
  const jobsRows = rows.jobs || [];
  const groups = rows.groups || [];
  const areas = rows.areas || [];
  const templates = rows.templates || [];
  const tasks = rows.tasks || [];
  const evidence = rows.evidence || [];

  const byJob = new Map(); // jobLegacy → { job, areasById }
  const jobs = jobsRows.map((j) => {
    const job = {
      id: j.legacy_id, name: j.name, status: j.status, ref: j.ref,
      type: j.job_type_label, serviceM8JobId: j.external_ref, siteAddress: j.site_address,
      siteContactName: j.site_contact_name, siteContactPhone: j.site_contact_phone,
      accessNotes: j.access_notes, parkingNotes: j.parking_notes, safetyNotes: j.safety_notes,
      inductionRequired: j.induction_required, startDate: j.start_date, dueDate: j.due_date,
      programmedDurationDays: j.programmed_duration_days, createdAt: j.created_at,
      areaGroups: [], roughInTasks: [], fitOffTasks: [],
    };
    byJob.set(j.legacy_id, { job, groupsById: new Map(), areasById: new Map() });
    return job;
  });

  for (const g of groups) {
    const ctx = byJob.get(g.job_legacy);
    if (!ctx) continue;
    const group = { id: localId(g.legacy_id), name: g.name, order: g.sort_order, archived: g.archived === true, areas: [] };
    ctx.groupsById.set(g.legacy_id, group);
    ctx.job.areaGroups.push(group);
  }
  for (const a of areas) {
    const ctx = byJob.get(a.job_legacy);
    if (!ctx) continue;
    const group = a.group_legacy ? ctx.groupsById.get(a.group_legacy) : null;
    // Fail closed: the Blob model nests every area inside a group (the importer
    // always sets group_id). An area with no group, or a group_legacy that doesn't
    // resolve, can't be placed in areaGroups — rather than silently drop it from
    // the reconstructed shape, throw. readJobsFromPgIfEnabled is best-effort, so
    // this degrades to a clean Blob fallback rather than serving partial data.
    if (!group) {
      throw new Error(`area ${a.legacy_id}: no resolvable group (group_legacy=${a.group_legacy}) — cannot reconstruct the Blob shape`);
    }
    const area = {
      id: localId(a.legacy_id), name: a.name, spaceType: a.space_type, order: a.sort_order,
      archived: a.archived === true, ...emptyStageLists(),
    };
    ctx.areasById.set(a.legacy_id, area);
    group.areas.push(area);
  }
  for (const t of templates) {
    const ctx = byJob.get(t.job_legacy);
    if (!ctx) continue;
    const entry = { id: t.legacy_id, name: t.name, order: t.sort_order, archived: t.archived === true };
    const key = STAGE_KEYS[t.stage];
    if (!key) continue;
    if (t.area_legacy) {
      const area = ctx.areasById.get(t.area_legacy);
      if (area) area[key].push(entry);
    } else {
      ctx.job[key].push(entry); // job-level default
    }
  }

  const jobData = {};
  const dataFor = (jobLegacy) => {
    if (!jobData[jobLegacy]) jobData[jobLegacy] = { dwellings: {}, evidence: [], snags: [], notes: [] };
    return jobData[jobLegacy];
  };
  for (const t of tasks) {
    if (!byJob.has(t.job_legacy) || !t.area_legacy || !STAGE_KEYS[t.stage] || !t.legacy_template_id) continue;
    const areaId = localId(t.area_legacy);
    const d = dataFor(t.job_legacy).dwellings;
    if (!d[areaId]) d[areaId] = {};
    if (!d[areaId][t.stage]) d[areaId][t.stage] = { tasks: {} };
    d[areaId][t.stage].tasks[t.legacy_template_id] = t.status;
  }
  for (const e of evidence) {
    if (!byJob.has(e.job_legacy)) continue;
    dataFor(e.job_legacy).evidence.push({
      id: e.legacy_id, kind: e.kind, photoId: e.photo_blob_id, photoUrl: e.blob_url,
      thumbnailUrl: e.thumbnail_url, note: e.note,
      areaId: e.area_legacy ? localId(e.area_legacy) : null,
      stage: e.stage, taskId: e.task_legacy_template_id || null,
      capturedById: e.captured_by_legacy || null, capturedByName: e.captured_by_label,
      capturedAt: e.captured_at, clientCapturedAt: e.client_captured_at,
      exifLocation: e.exif_lat != null || e.exif_lng != null ? { lat: e.exif_lat, lng: e.exif_lng } : null,
      status: e.status, source: e.source,
      reviewedById: e.reviewed_by_legacy || null, reviewedByName: e.reviewed_by_label,
      reviewedAt: e.reviewed_at, rejectionReason: e.rejection_reason, createdAt: e.created_at,
    });
  }

  return { jobs: { jobs }, jobData };
}

// Query the PG graph (with parent-legacy joins) and reconstruct. Structure rows
// include archived (deleted_at not null) so the reconstruction round-trips
// archived groups/areas/templates as `archived:true` blob entries.
async function loadJobStructureFromPg(sql, tenantId) {
  const jobs = await sql`
    select legacy_id, name, status, ref, job_type_label, external_ref, site_address,
           site_contact_name, site_contact_phone, access_notes, parking_notes, safety_notes,
           induction_required, start_date::text as start_date, due_date::text as due_date,
           programmed_duration_days, created_at::text as created_at
    from public.jobs where tenant_id = ${tenantId} and legacy_id is not null and deleted_at is null`;
  const groups = await sql`
    select g.legacy_id, jb.legacy_id as job_legacy, g.name, g.sort_order, (g.deleted_at is not null) as archived
    from public.site_area_groups g join public.jobs jb on jb.id = g.job_id
    where g.tenant_id = ${tenantId} and g.legacy_id is not null`;
  const areas = await sql`
    select a.legacy_id, jb.legacy_id as job_legacy, gp.legacy_id as group_legacy, a.name, a.space_type,
           a.sort_order, (a.deleted_at is not null) as archived
    from public.site_areas a join public.jobs jb on jb.id = a.job_id
    left join public.site_area_groups gp on gp.id = a.group_id
    where a.tenant_id = ${tenantId} and a.legacy_id is not null`;
  const templates = await sql`
    select t.legacy_id, jb.legacy_id as job_legacy, ar.legacy_id as area_legacy, t.stage, t.name,
           t.sort_order, (t.deleted_at is not null) as archived
    from public.job_task_templates t join public.jobs jb on jb.id = t.job_id
    left join public.site_areas ar on ar.id = t.site_area_id
    where t.tenant_id = ${tenantId} and t.legacy_id is not null`;
  const tasks = await sql`
    select jb.legacy_id as job_legacy, ar.legacy_id as area_legacy, t.stage, t.legacy_template_id, t.status
    from public.tasks t join public.jobs jb on jb.id = t.job_id
    join public.site_areas ar on ar.id = t.site_area_id
    where t.tenant_id = ${tenantId} and t.legacy_template_id is not null and t.deleted_at is null`;
  const evidence = await sql`
    select ef.legacy_id, jb.legacy_id as job_legacy, ar.legacy_id as area_legacy,
           tk.legacy_template_id as task_legacy_template_id, ef.kind, ef.photo_blob_id, ef.blob_url,
           ef.thumbnail_url, ef.note, ef.stage, cu.legacy_user_id as captured_by_legacy, ef.captured_by_label,
           ef.captured_at::text as captured_at, ef.client_captured_at::text as client_captured_at,
           ef.exif_lat, ef.exif_lng, ef.status, ef.source, ru.legacy_user_id as reviewed_by_legacy,
           ef.reviewed_by_label, ef.reviewed_at::text as reviewed_at, ef.rejection_reason, ef.created_at::text as created_at
    from public.evidence_files ef join public.jobs jb on jb.id = ef.job_id
    left join public.site_areas ar on ar.id = ef.site_area_id
    left join public.tasks tk on tk.id = ef.task_id
    left join public.user_profiles cu on cu.id = ef.captured_by
    left join public.user_profiles ru on ru.id = ef.reviewed_by
    where ef.tenant_id = ${tenantId} and ef.legacy_id is not null and ef.deleted_at is null`;

  return reconstructFromPg({
    jobs: [...jobs], groups: [...groups], areas: [...areas],
    templates: [...templates], tasks: [...tasks], evidence: [...evidence],
  });
}

/**
 * DARK reader. Returns { pg:false } unless the `supabase_read_jobs` flag is ON
 * (so Blob stays authoritative), and best-effort: any error → { pg:false } for a
 * clean Blob fallback. Injectable deps for tests.
 */
async function readJobsFromPgIfEnabled(deps = {}) {
  const { getDb = realGetDb, isFlagOn = realIsFlagOn, tenantSlug = 'buhl' } = deps;
  if (!process.env.SUPABASE_DB_URL) return { pg: false, reason: 'no supabase env' };
  try {
    if (!(await isFlagOn('supabase_read_jobs'))) return { pg: false, reason: 'flag off' };
    const sql = getDb({ mode: 'read' });
    const tenant = await sql`select id from public.tenants where slug = ${tenantSlug}`;
    if (!tenant.length) return { pg: false, reason: 'no tenant' };
    const sources = await loadJobStructureFromPg(sql, tenant[0].id);
    return { pg: true, sources };
  } catch (err) {
    console.warn('[job-read-projection] PG read failed (Blob authoritative):', err && err.message ? err.message : err);
    return { pg: false, reason: 'error' };
  }
}

function realGetDb(opts) {
  return require('./supabase-db').getDb(opts);
}
function realIsFlagOn(key) {
  return require('./feature-flags').isFlagOn(key);
}

module.exports = { reconstructFromPg, loadJobStructureFromPg, readJobsFromPgIfEnabled };
