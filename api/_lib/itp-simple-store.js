// Simple mobile ITP builder — Postgres store (#912, lean-reset step 6).
//
// These tables ARE the metadata source of truth (Supabase-first directive,
// docs/product/02-lean-reset.md) — no Blob JSON mirror. Binaries (photos,
// generated PDFs) live in Vercel Blob; rows carry the URLs.
//
// Shape mirrors the house PG idiom (api/_lib/hours-mirror.js): every function
// takes the Postgres.js `sql` handle the caller opened through the env guard
// (api/_lib/supabase-db getDb) — nothing here opens a connection — and the
// tenant is resolved once per request by slug. Errors THROW: unlike the hours
// mirror (a side-write that must never break the request), this store is the
// primary store; the handler turns failures into 500s.

const TENANT_SLUG = 'buhl';

/** Resolve the single-tenant row id, or null when the schema isn't seeded. */
async function resolveTenantId(sql) {
  const t = await sql`select id from public.tenants where slug = ${TENANT_SLUG}`;
  return t.length ? t[0].id : null;
}

/** Resolve a legacy job id to the public.jobs uuid (null when unmirrored —
 *  the report still carries job_legacy_id, so nothing is lost). */
async function resolveJobUuid(sql, tenantId, jobLegacyId) {
  const rows = await sql`
    select id from public.jobs
    where tenant_id = ${tenantId} and legacy_id = ${jobLegacyId} and deleted_at is null
    limit 1`;
  return rows.length ? rows[0].id : null;
}

function reportSummary(r) {
  return {
    id: r.id,
    title: r.title,
    areaCount: Number(r.area_count || 0),
    photoCount: Number(r.photo_count || 0),
    pdfUrl: r.pdf_url || null,
    pdfGeneratedAt: r.pdf_generated_at || null,
    createdBy: r.created_by_name || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** All live reports for a job, newest first, with area/photo counts. */
async function listReports(sql, tenantId, jobLegacyId) {
  const rows = await sql`
    select r.*,
      (select count(*) from public.itp_simple_areas a where a.report_id = r.id) as area_count,
      (select count(*) from public.itp_simple_photos p
        join public.itp_simple_areas a on a.id = p.area_id
        where a.report_id = r.id) as photo_count
    from public.itp_simple_reports r
    where r.tenant_id = ${tenantId} and r.job_legacy_id = ${jobLegacyId}
      and r.deleted_at is null
    order by r.created_at desc`;
  return rows.map(reportSummary);
}

/** One report with its areas (ordered) and their photos (ordered), or null.
 *  Job-scoped so a report id can never be read through another job's URL. */
async function getReport(sql, tenantId, jobLegacyId, reportId) {
  const reports = await sql`
    select * from public.itp_simple_reports
    where id = ${reportId} and tenant_id = ${tenantId}
      and job_legacy_id = ${jobLegacyId} and deleted_at is null`;
  if (!reports.length) return null;
  const r = reports[0];
  const areas = await sql`
    select * from public.itp_simple_areas
    where report_id = ${r.id}
    order by position, created_at`;
  const photos = areas.length
    ? await sql`
        select * from public.itp_simple_photos
        where area_id in ${sql(areas.map((a) => a.id))}
        order by created_at`
    : [];
  const byArea = new Map(areas.map((a) => [a.id, []]));
  for (const p of photos) {
    const bucket = byArea.get(p.area_id);
    if (bucket) bucket.push({
      id: p.id,
      url: p.blob_url,
      pathname: p.blob_pathname || null,
      caption: p.caption || '',
      takenBy: p.taken_by_name || '',
      createdAt: p.created_at,
    });
  }
  return {
    id: r.id,
    title: r.title,
    pdfUrl: r.pdf_url || null,
    pdfGeneratedAt: r.pdf_generated_at || null,
    createdBy: r.created_by_name || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    areas: areas.map((a) => ({
      id: a.id,
      name: a.name,
      position: a.position,
      createdAt: a.created_at,
      photos: byArea.get(a.id) || [],
    })),
  };
}

async function createReport(sql, tenantId, { jobLegacyId, title, user }) {
  const jobUuid = await resolveJobUuid(sql, tenantId, jobLegacyId);
  const rows = await sql`
    insert into public.itp_simple_reports
      (tenant_id, job_id, job_legacy_id, title, created_by_legacy_id, created_by_name)
    values (${tenantId}, ${jobUuid}, ${jobLegacyId}, ${title},
            ${user.id || null}, ${user.name || user.username || null})
    returning *`;
  return reportSummary({ ...rows[0], area_count: 0, photo_count: 0 });
}

/** Rename a report. Returns the row or null when it isn't this job's. */
async function renameReport(sql, tenantId, jobLegacyId, reportId, title) {
  const rows = await sql`
    update public.itp_simple_reports set title = ${title}
    where id = ${reportId} and tenant_id = ${tenantId}
      and job_legacy_id = ${jobLegacyId} and deleted_at is null
    returning id`;
  return rows.length > 0;
}

/** Soft-delete a report (areas/photos rows stay under it; Blob bytes follow
 *  the evidence orphan-GC story, not this store). */
async function deleteReport(sql, tenantId, jobLegacyId, reportId) {
  const rows = await sql`
    update public.itp_simple_reports set deleted_at = now()
    where id = ${reportId} and tenant_id = ${tenantId}
      and job_legacy_id = ${jobLegacyId} and deleted_at is null
    returning id`;
  return rows.length > 0;
}

/** Guard: the area's report must belong to this tenant + job and be live. */
async function areaInJob(sql, tenantId, jobLegacyId, areaId) {
  const rows = await sql`
    select a.id from public.itp_simple_areas a
    join public.itp_simple_reports r on r.id = a.report_id
    where a.id = ${areaId} and r.tenant_id = ${tenantId}
      and r.job_legacy_id = ${jobLegacyId} and r.deleted_at is null`;
  return rows.length > 0;
}

async function addArea(sql, tenantId, jobLegacyId, reportId, name) {
  const owned = await sql`
    select id from public.itp_simple_reports
    where id = ${reportId} and tenant_id = ${tenantId}
      and job_legacy_id = ${jobLegacyId} and deleted_at is null`;
  if (!owned.length) return null;
  const rows = await sql`
    insert into public.itp_simple_areas (tenant_id, report_id, name, position)
    values (${tenantId}, ${reportId}, ${name},
            coalesce((select max(position) + 1 from public.itp_simple_areas
                      where report_id = ${reportId}), 0))
    returning *`;
  const a = rows[0];
  return { id: a.id, name: a.name, position: a.position, photos: [] };
}

async function renameArea(sql, tenantId, jobLegacyId, areaId, name) {
  if (!(await areaInJob(sql, tenantId, jobLegacyId, areaId))) return false;
  await sql`update public.itp_simple_areas set name = ${name} where id = ${areaId}`;
  return true;
}

/** Hard-delete an area and (FK cascade) its photo rows. */
async function deleteArea(sql, tenantId, jobLegacyId, areaId) {
  if (!(await areaInJob(sql, tenantId, jobLegacyId, areaId))) return false;
  await sql`delete from public.itp_simple_areas where id = ${areaId}`;
  return true;
}

async function addPhoto(sql, tenantId, jobLegacyId, areaId, { url, pathname, caption, user }) {
  if (!(await areaInJob(sql, tenantId, jobLegacyId, areaId))) return null;
  const rows = await sql`
    insert into public.itp_simple_photos
      (tenant_id, area_id, blob_url, blob_pathname, caption, taken_by_legacy_id, taken_by_name)
    values (${tenantId}, ${areaId}, ${url}, ${pathname || null}, ${caption || null},
            ${user.id || null}, ${user.name || user.username || null})
    returning *`;
  const p = rows[0];
  return {
    id: p.id,
    url: p.blob_url,
    pathname: p.blob_pathname || null,
    caption: p.caption || '',
    takenBy: p.taken_by_name || '',
    createdAt: p.created_at,
  };
}

async function deletePhoto(sql, tenantId, jobLegacyId, photoId) {
  const rows = await sql`
    delete from public.itp_simple_photos p
    using public.itp_simple_areas a, public.itp_simple_reports r
    where p.id = ${photoId} and a.id = p.area_id and r.id = a.report_id
      and r.tenant_id = ${tenantId} and r.job_legacy_id = ${jobLegacyId}
      and r.deleted_at is null
    returning p.id`;
  return rows.length > 0;
}

/** Stamp the latest generated PDF artifact onto the report. */
async function stampPdf(sql, tenantId, jobLegacyId, reportId, pdfUrl) {
  const rows = await sql`
    update public.itp_simple_reports
    set pdf_url = ${pdfUrl}, pdf_generated_at = now()
    where id = ${reportId} and tenant_id = ${tenantId}
      and job_legacy_id = ${jobLegacyId} and deleted_at is null
    returning pdf_generated_at`;
  return rows.length ? rows[0].pdf_generated_at : null;
}

module.exports = {
  resolveTenantId,
  resolveJobUuid,
  listReports,
  getReport,
  createReport,
  renameReport,
  deleteReport,
  addArea,
  renameArea,
  deleteArea,
  addPhoto,
  deletePhoto,
  stampPdf,
};
