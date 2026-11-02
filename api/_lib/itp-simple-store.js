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

/** Caption a photo (prints under it in the PDF). Job-scoped like deletePhoto. */
async function updatePhotoCaption(sql, tenantId, jobLegacyId, photoId, caption) {
  const rows = await sql`
    update public.itp_simple_photos p set caption = ${caption || null}
    from public.itp_simple_areas a, public.itp_simple_reports r
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


// ── PDFs (handoff 2026-11-02: several per ITP) ─────────────────────────

function pdfRow(r) {
  return {
    id: r.id,
    reportId: r.report_id,
    name: r.name,
    nameIsAuto: !!r.name_is_auto,
    areaIds: r.area_ids || [],
    snapshot: r.snapshot || { areas: [] },
    contentKey: r.content_key || '',
    areaCount: Number(r.area_count || 0),
    photoCount: Number(r.photo_count || 0),
    url: r.blob_url,
    pathname: r.blob_pathname || null,
    madeAt: r.made_at,
    madeBy: r.made_by_name || '',
  };
}

/** Guard: the PDF's report must belong to this tenant + job and be live. */
async function getPdf(sql, tenantId, jobLegacyId, pdfId) {
  const rows = await sql`
    select p.* from public.itp_simple_pdfs p
    join public.itp_simple_reports r on r.id = p.report_id
    where p.id = ${pdfId} and r.tenant_id = ${tenantId}
      and r.job_legacy_id = ${jobLegacyId} and r.deleted_at is null`;
  return rows.length ? pdfRow(rows[0]) : null;
}

async function listPdfs(sql, reportId) {
  const rows = await sql`
    select * from public.itp_simple_pdfs
    where report_id = ${reportId}
    order by made_at desc`;
  return rows.map(pdfRow);
}

async function createPdf(sql, tenantId, reportId, {
  name, nameIsAuto, areaIds, snapshot, contentKey, areaCount, photoCount, url, pathname, byteSize, user,
}) {
  const rows = await sql`
    insert into public.itp_simple_pdfs
      (tenant_id, report_id, name, name_is_auto, area_ids, snapshot, content_key,
       area_count, photo_count, blob_url, blob_pathname, byte_size, made_by_legacy_id, made_by_name)
    values (${tenantId}, ${reportId}, ${name}, ${!!nameIsAuto}, ${areaIds}, ${sql.json(snapshot)},
            ${contentKey}, ${areaCount}, ${photoCount}, ${url}, ${pathname || null}, ${byteSize || null},
            ${user.id || null}, ${user.name || user.username || null})
    returning *`;
  return pdfRow(rows[0]);
}

/** Make again / rename re-render: replace the file (and, when given, the
 *  snapshot + fingerprint) on the SAME row. */
async function replacePdfFile(sql, pdfId, {
  name, nameIsAuto, snapshot, contentKey, areaCount, photoCount, url, pathname, byteSize, user, touchMadeAt,
}) {
  const rows = await sql`
    update public.itp_simple_pdfs set
      name = coalesce(${name == null ? null : name}, name),
      name_is_auto = coalesce(${nameIsAuto == null ? null : !!nameIsAuto}, name_is_auto),
      snapshot = coalesce(${snapshot == null ? null : sql.json(snapshot)}, snapshot),
      content_key = coalesce(${contentKey == null ? null : contentKey}, content_key),
      area_count = coalesce(${areaCount == null ? null : areaCount}, area_count),
      photo_count = coalesce(${photoCount == null ? null : photoCount}, photo_count),
      blob_url = ${url},
      blob_pathname = ${pathname || null},
      byte_size = ${byteSize || null},
      made_at = case when ${!!touchMadeAt} then now() else made_at end,
      made_by_legacy_id = case when ${!!touchMadeAt} then ${user.id || null} else made_by_legacy_id end,
      made_by_name = case when ${!!touchMadeAt} then ${user.name || user.username || null} else made_by_name end
    where id = ${pdfId}
    returning *`;
  return rows.length ? pdfRow(rows[0]) : null;
}

// ── Send log ───────────────────────────────────────────────────────────

function sendRow(s) {
  return {
    id: s.id,
    pdfId: s.pdf_id || null,
    kind: s.kind,
    recipient: s.recipient,
    pdfName: s.pdf_name,
    attached: !!s.attached,
    result: s.result,
    failure: s.failure || null,
    sentBy: s.sent_by_name || '',
    sentAt: s.sent_at,
  };
}

async function logSend(sql, tenantId, jobLegacyId, reportId, {
  pdfId, kind, recipient, pdfName, attached, result, failure, user,
}) {
  const rows = await sql`
    insert into public.itp_simple_sends
      (tenant_id, report_id, pdf_id, job_legacy_id, kind, recipient, pdf_name, attached,
       result, failure, sent_by_legacy_id, sent_by_name)
    values (${tenantId}, ${reportId}, ${pdfId || null}, ${jobLegacyId}, ${kind}, ${recipient},
            ${pdfName}, ${attached !== false}, ${result}, ${failure || null},
            ${user.id || null}, ${user.name || user.username || null})
    returning *`;
  return sendRow(rows[0]);
}

/** Every send for a report, newest first (failed ones included — P7). */
async function listSends(sql, reportId) {
  const rows = await sql`
    select * from public.itp_simple_sends
    where report_id = ${reportId}
    order by sent_at desc`;
  return rows.map(sendRow);
}

/** Addresses successfully emailed to on this job, newest first — the
 *  "Used on this job" chips. */
async function recentEmailRecipients(sql, tenantId, jobLegacyId, limit = 8) {
  const rows = await sql`
    select recipient, max(sent_at) as last_at
    from public.itp_simple_sends
    where tenant_id = ${tenantId} and job_legacy_id = ${jobLegacyId}
      and kind = 'email' and result = 'sent'
    group by recipient
    order by last_at desc
    limit ${limit}`;
  return rows.map((r) => r.recipient);
}

// ── Per-report facts for the list badges ───────────────────────────────

/** For a set of reports: their pdfs, the live per-area photo facts (so the
 *  handler can work out which pdfs are out of date) and the latest
 *  successful send. One query each, not one per report. */
async function reportFacts(sql, reportIds) {
  if (!reportIds.length) return { pdfsByReport: new Map(), areasByReport: new Map(), lastSendByReport: new Map() };
  const [pdfs, areas, photos, sends] = await Promise.all([
    sql`select * from public.itp_simple_pdfs where report_id in ${sql(reportIds)} order by made_at desc`,
    sql`select id, report_id, name from public.itp_simple_areas where report_id in ${sql(reportIds)} order by position, created_at`,
    sql`select p.id, p.area_id, p.caption, a.report_id
        from public.itp_simple_photos p
        join public.itp_simple_areas a on a.id = p.area_id
        where a.report_id in ${sql(reportIds)}
        order by p.created_at`,
    sql`select distinct on (report_id) * from public.itp_simple_sends
        where report_id in ${sql(reportIds)} and result = 'sent'
        order by report_id, sent_at desc`,
  ]);
  const pdfsByReport = new Map();
  for (const p of pdfs) {
    if (!pdfsByReport.has(p.report_id)) pdfsByReport.set(p.report_id, []);
    pdfsByReport.get(p.report_id).push(pdfRow(p));
  }
  const areaById = new Map();
  const areasByReport = new Map();
  for (const a of areas) {
    const row = { id: a.id, name: a.name, photos: [] };
    areaById.set(a.id, row);
    if (!areasByReport.has(a.report_id)) areasByReport.set(a.report_id, []);
    areasByReport.get(a.report_id).push(row);
  }
  for (const p of photos) {
    const a = areaById.get(p.area_id);
    if (a) a.photos.push({ id: p.id, caption: p.caption || '' });
  }
  const lastSendByReport = new Map(sends.map((s) => [s.report_id, sendRow(s)]));
  return { pdfsByReport, areasByReport, lastSendByReport };
}

/** Area names of the most recent OTHER live report on this job (the "last
 *  ITP's" names for the Recent names chips), capture order. */
async function lastReportAreaNames(sql, tenantId, jobLegacyId, excludeReportId) {
  const rows = await sql`
    select a.name from public.itp_simple_areas a
    join public.itp_simple_reports r on r.id = a.report_id
    where r.tenant_id = ${tenantId} and r.job_legacy_id = ${jobLegacyId}
      and r.deleted_at is null and r.id <> ${excludeReportId}
      and r.id = (
        select id from public.itp_simple_reports
        where tenant_id = ${tenantId} and job_legacy_id = ${jobLegacyId}
          and deleted_at is null and id <> ${excludeReportId}
        order by created_at desc limit 1)
    order by a.position, a.created_at`;
  return rows.map((r) => r.name);
}

// ── Per-person prefs ───────────────────────────────────────────────────

async function walkthroughSeen(sql, tenantId, userLegacyId) {
  const rows = await sql`
    select walkthrough_seen_at from public.itp_simple_user_prefs
    where tenant_id = ${tenantId} and user_legacy_id = ${userLegacyId}`;
  return rows.length > 0 && rows[0].walkthrough_seen_at != null;
}

async function markWalkthroughSeen(sql, tenantId, userLegacyId) {
  await sql`
    insert into public.itp_simple_user_prefs (tenant_id, user_legacy_id, walkthrough_seen_at)
    values (${tenantId}, ${userLegacyId}, now())
    on conflict (tenant_id, user_legacy_id)
      do update set walkthrough_seen_at = coalesce(public.itp_simple_user_prefs.walkthrough_seen_at, now())`;
  return true;
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
  updatePhotoCaption,
  stampPdf,
  getPdf,
  listPdfs,
  createPdf,
  replacePdfFile,
  logSend,
  listSends,
  recentEmailRecipients,
  reportFacts,
  lastReportAreaNames,
  walkthroughSeen,
  markWalkthroughSeen,
};
