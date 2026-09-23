'use strict';

// Supplier-invoice Postgres store (Supabase-first metadata; the tables ARE the
// store — migration 20260915100000_supplier_invoices.sql). Same house idiom as
// api/_lib/itp-simple-store.js: every function takes the Postgres.js `sql`
// handle the caller opened through the env guard (api/_lib/supabase-db getDb),
// the tenant is resolved once per request, and every query is tenant-scoped.
// Errors THROW; the handler turns them into stable machine-readable errors.
//
// Money columns are bigint → Postgres.js returns strings; every read maps
// them back to integer cents (Number) so the API never emits a string amount.

const TENANT_SLUG = 'buhl';
const MAX_ATTEMPTS = 3;
const STALE_PROCESSING_MS = 10 * 60 * 1000;

const UNIQUE_VIOLATION = '23505';

function cents(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function iso(v) {
  return v == null ? null : v instanceof Date ? v.toISOString() : String(v);
}
function dateOnly(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
function json(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
  return v;
}

/** Resolve the single-tenant row, or null when the schema isn't seeded. */
async function resolveTenant(sql) {
  const t = await sql`select id, slug from public.tenants where slug = ${TENANT_SLUG}`;
  return t.length ? { id: t[0].id, slug: t[0].slug } : null;
}

/** Legacy job id → public.jobs uuid (null when the job isn't mirrored yet). */
async function resolveJobUuid(sql, tenantId, jobLegacyId) {
  if (!jobLegacyId) return null;
  const rows = await sql`
    select id from public.jobs
    where tenant_id = ${tenantId} and legacy_id = ${jobLegacyId} and deleted_at is null
    limit 1`;
  return rows.length ? rows[0].id : null;
}

// ── row mappers ─────────────────────────────────────────────────────────────
function invoiceRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    status: r.status,
    source: r.source,
    documentType: r.document_type,
    supplierName: r.supplier_name,
    supplierKey: r.supplier_key,
    supplierAbn: r.supplier_abn,
    supplierInvoiceNumber: r.supplier_invoice_number,
    invoiceDate: dateOnly(r.invoice_date),
    currency: r.currency,
    subtotalCents: cents(r.subtotal_ex_gst_cents),
    gstCents: cents(r.gst_cents),
    totalCents: cents(r.total_inc_gst_cents),
    totalsConsistent: r.totals_consistent,
    ivReferenceRaw: r.iv_reference_raw,
    ivReference: r.iv_reference_normalised,
    ivCandidates: json(r.iv_candidates, []),
    matchedJobId: r.matched_job_legacy_id,
    matchStatus: r.match_status,
    matchReason: json(r.match_reason, null),
    reviewReasons: json(r.review_reasons, []),
    failureCode: r.failure_code,
    extractionMethod: r.extraction_method,
    fields: json(r.extraction_confidence, {}),
    excerpt: r.extracted_text_excerpt,
    attemptCount: Number(r.attempt_count || 0),
    nextAttemptAt: iso(r.next_attempt_at),
    duplicateOfId: r.duplicate_of_id,
    duplicateReason: r.duplicate_reason,
    sourceEmailId: r.source_email_id,
    sourceMessageId: r.source_message_id,
    sourceSubject: r.source_subject,
    sourceFrom: r.source_from,
    createdBy: r.created_by_name,
    reviewedAt: iso(r.reviewed_at),
    reviewedBy: r.reviewed_by_name,
    confirmedAt: iso(r.confirmed_at),
    confirmedBy: r.confirmed_by_name,
    excludedReason: r.excluded_reason,
    archivedAt: iso(r.archived_at),
    autoConfirmEligible: r.auto_confirm_eligible === true,
    autoConfirmAt: iso(r.auto_confirm_at),
    autoConfirmChecks: json(r.auto_confirm_checks, []),
    heldAt: iso(r.held_at),
    heldBy: r.held_by_name || null,
    sourceLinks: json(r.source_links, []),
    sourceTextExcerpt: r.source_text_excerpt || null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function documentRow(r) {
  return {
    id: r.id,
    invoiceId: r.invoice_id,
    source: r.source,
    kind: r.kind || 'pdf',
    filename: r.original_filename,
    contentType: r.content_type,
    byteSize: Number(r.byte_size || 0),
    sha256: r.sha256,
    pageCount: r.page_count,
    hasTextLayer: r.has_text_layer,
    uploadedBy: r.uploaded_by_name,
    createdAt: iso(r.created_at),
    // blob_url / blob_pathname deliberately NOT mapped: server-only
  };
}

function allocationRow(r) {
  return {
    id: r.id,
    invoiceId: r.invoice_id,
    jobId: r.job_legacy_id,
    amountCents: cents(r.amount_ex_gst_cents),
    gstCents: cents(r.gst_cents),
    totalCents: cents(r.total_inc_gst_cents),
    status: r.status,
    confirmedBy: r.confirmed_by_name,
    confirmedAt: iso(r.confirmed_at),
    reversedAt: iso(r.reversed_at),
    reversedBy: r.reversed_by_name,
    reversalReason: r.reversal_reason,
  };
}

function eventRow(r) {
  return { id: r.id, event: r.event, actor: r.actor_name, actorRole: r.actor_role, detail: json(r.detail, {}), at: iso(r.created_at) };
}

function attemptRow(r) {
  return { id: r.id, attemptNo: r.attempt_no, trigger: r.trigger, startedAt: iso(r.started_at), finishedAt: iso(r.finished_at), outcome: r.outcome, failureCode: r.failure_code, extractionMethod: r.extraction_method };
}

// ── invoices ────────────────────────────────────────────────────────────────
async function createInvoice(sql, tenantId, input) {
  const rows = await sql`
    insert into public.supplier_invoices
      (tenant_id, source, status, source_email_id, source_message_id, source_subject, source_from,
       source_links, source_text_excerpt, review_reasons, created_by_legacy_id, created_by_name)
    values (${tenantId}, ${input.source}, ${input.status || 'received'},
            ${input.sourceEmailId || null}, ${input.sourceMessageId || null},
            ${input.sourceSubject || null}, ${input.sourceFrom || null},
            ${sql.json(input.sourceLinks || [])}, ${input.sourceTextExcerpt || null}, ${sql.json(input.reviewReasons || [])},
            ${(input.createdBy && input.createdBy.id) || null}, ${(input.createdBy && input.createdBy.name) || null})
    returning *`;
  return invoiceRow(rows[0]);
}

/**
 * Create the invoice AND its first document in ONE transaction. The document's
 * provider identity is unique, so a replayed delivery rolls the whole thing
 * back and returns null — no orphan invoice rows.
 */
async function createInvoiceWithDocument(sql, tenantId, invoiceInput, docInput) {
  try {
    return await sql.begin(async (tx) => {
      const invoice = await createInvoice(tx, tenantId, invoiceInput);
      const rows = await tx`
        insert into public.supplier_invoice_documents
          (tenant_id, invoice_id, source, kind, provider_email_id, provider_attachment_id, original_filename,
           content_type, byte_size, sha256, blob_pathname, blob_url, uploaded_by_legacy_id, uploaded_by_name)
        values (${tenantId}, ${invoice.id}, ${docInput.source}, ${docInput.kind || 'pdf'}, ${docInput.providerEmailId || null}, ${docInput.providerAttachmentId || null},
                ${docInput.filename}, ${docInput.contentType}, ${docInput.byteSize}, ${docInput.sha256}, ${docInput.blobPathname}, ${docInput.blobUrl},
                ${(docInput.uploadedBy && docInput.uploadedBy.id) || null}, ${(docInput.uploadedBy && docInput.uploadedBy.name) || null})
        returning *`;
      await insertEvent(tx, tenantId, invoice.id, {
        event: invoiceInput.source === 'email' ? 'received' : 'uploaded',
        actor: invoiceInput.createdBy || null,
        detail: { filename: docInput.filename, byteSize: docInput.byteSize, sha256: docInput.sha256, emailId: docInput.providerEmailId || null },
      });
      return { invoice, document: documentRow(rows[0]) };
    });
  } catch (e) {
    if (e && e.code === UNIQUE_VIOLATION) return null;
    throw e;
  }
}

async function getInvoiceRow(sql, tenantId, id) {
  const rows = await sql`select * from public.supplier_invoices where id = ${id} and tenant_id = ${tenantId}`;
  return rows.length ? invoiceRow(rows[0]) : null;
}

/** One invoice with its documents, allocations, events and attempts (tenant-scoped). */
async function getInvoiceDetail(sql, tenantId, id) {
  const invoice = await getInvoiceRow(sql, tenantId, id);
  if (!invoice) return null;
  const [docs, allocs, events, attempts] = await Promise.all([
    sql`select * from public.supplier_invoice_documents where invoice_id = ${id} and tenant_id = ${tenantId} order by created_at`,
    sql`select * from public.supplier_invoice_allocations where invoice_id = ${id} and tenant_id = ${tenantId} order by created_at`,
    sql`select * from public.supplier_invoice_events where invoice_id = ${id} and tenant_id = ${tenantId} order by created_at`,
    sql`select * from public.supplier_invoice_attempts where invoice_id = ${id} and tenant_id = ${tenantId} order by attempt_no`,
  ]);
  return {
    invoice,
    documents: docs.map(documentRow),
    allocations: allocs.map(allocationRow),
    events: events.map(eventRow),
    attempts: attempts.map(attemptRow),
  };
}

/** Server-only: the document row INCLUDING its blob url (for the proxy + pipeline). */
async function getDocumentWithBlob(sql, tenantId, invoiceId, documentId) {
  const rows = documentId
    ? await sql`select * from public.supplier_invoice_documents where id = ${documentId} and invoice_id = ${invoiceId} and tenant_id = ${tenantId}`
    : await sql`select * from public.supplier_invoice_documents where invoice_id = ${invoiceId} and tenant_id = ${tenantId} order by created_at limit 1`;
  if (!rows.length) return null;
  const r = rows[0];
  return { ...documentRow(r), blobUrl: r.blob_url, blobPathname: r.blob_pathname };
}

const LIST_MAX = 100;

/**
 * Paginated, filtered list. Filters: status (one or many), supplier (key or
 * name substring), jobId (matched job legacy id), from/to (invoice date, or
 * created_at when no invoice date), q (supplier / invoice number / IV ref).
 */
async function listInvoices(sql, tenantId, f = {}) {
  const limit = Math.min(LIST_MAX, Math.max(1, Number(f.limit) || 25));
  const page = Math.max(1, Number(f.page) || 1);
  const offset = (page - 1) * limit;
  const statuses = Array.isArray(f.status) ? f.status.filter(Boolean) : f.status ? [f.status] : [];
  const like = (s) => `%${String(s).replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const where = sql`
    where tenant_id = ${tenantId}
    ${statuses.length ? sql`and status in ${sql(statuses)}` : sql``}
    ${f.supplier ? sql`and (supplier_key = ${f.supplier} or supplier_name ilike ${like(f.supplier)})` : sql``}
    ${f.jobId ? sql`and matched_job_legacy_id = ${f.jobId}` : sql``}
    ${f.autoConfirm === 'pending' ? sql`and auto_confirm_eligible and auto_confirm_at is not null and held_at is null and status = 'matched'` : sql``}
    ${f.from ? sql`and coalesce(invoice_date, created_at::date) >= ${f.from}::date` : sql``}
    ${f.to ? sql`and coalesce(invoice_date, created_at::date) <= ${f.to}::date` : sql``}
    ${f.q ? sql`and (supplier_name ilike ${like(f.q)} or supplier_invoice_number ilike ${like(f.q)}
                     or iv_reference_normalised ilike ${like(f.q)} or matched_job_legacy_id ilike ${like(f.q)}
                     or source_subject ilike ${like(f.q)})` : sql``}`;
  const [rows, count] = await Promise.all([
    sql`select * from public.supplier_invoices ${where} order by created_at desc limit ${limit} offset ${offset}`,
    sql`select count(*)::int as n from public.supplier_invoices ${where}`,
  ]);
  return { rows: rows.map(invoiceRow), total: Number(count[0].n), page, limit };
}

async function countsByStatus(sql, tenantId) {
  const rows = await sql`select status, count(*)::int as n from public.supplier_invoices where tenant_id = ${tenantId} group by status`;
  const out = {};
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

async function listSuppliers(sql, tenantId) {
  const rows = await sql`
    select supplier_key, min(supplier_name) as supplier_name, count(*)::int as n
    from public.supplier_invoices
    where tenant_id = ${tenantId} and supplier_key is not null
    group by supplier_key order by min(supplier_name)`;
  return rows.map((r) => ({ key: r.supplier_key, name: r.supplier_name, count: Number(r.n) }));
}

/** This supplier's captured documents (for the statement check), newest first. */
async function listSupplierInvoices(sql, tenantId, supplierKey, excludeInvoiceId) {
  if (!supplierKey) return [];
  const rows = await sql`
    select id, supplier_invoice_number, status, document_type, subtotal_ex_gst_cents as subtotal, total_inc_gst_cents as total
    from public.supplier_invoices
    where tenant_id = ${tenantId} and supplier_key = ${supplierKey} and id <> ${excludeInvoiceId}
      and supplier_invoice_number is not null
    order by created_at desc limit 500`;
  return rows.map((r) => ({ id: r.id, supplierInvoiceNumber: r.supplier_invoice_number, status: r.status, documentType: r.document_type, subtotalCents: cents(r.subtotal), totalCents: cents(r.total) }));
}

/** Patch extraction + match + status fields in one UPDATE (pipeline result). */
async function applyExtraction(sql, tenantId, id, p) {
  const rows = await sql`
    update public.supplier_invoices set
      supplier_name = ${p.supplierName == null ? null : p.supplierName},
      supplier_key = ${p.supplierKey == null ? null : p.supplierKey},
      supplier_abn = ${p.supplierAbn == null ? null : p.supplierAbn},
      supplier_invoice_number = ${p.supplierInvoiceNumber == null ? null : p.supplierInvoiceNumber},
      document_type = ${p.documentType || 'unknown'},
      invoice_date = ${p.invoiceDate == null ? null : p.invoiceDate},
      currency = ${p.currency || 'AUD'},
      subtotal_ex_gst_cents = ${p.subtotalCents == null ? null : p.subtotalCents},
      gst_cents = ${p.gstCents == null ? null : p.gstCents},
      total_inc_gst_cents = ${p.totalCents == null ? null : p.totalCents},
      totals_consistent = ${p.totalsConsistent == null ? null : p.totalsConsistent},
      iv_reference_raw = ${p.ivReferenceRaw == null ? null : p.ivReferenceRaw},
      iv_reference_normalised = ${p.ivReference == null ? null : p.ivReference},
      iv_candidates = ${sql.json(p.ivCandidates || [])},
      matched_job_legacy_id = ${p.matchedJobId == null ? null : p.matchedJobId},
      matched_job_id = ${p.matchedJobUuid == null ? null : p.matchedJobUuid},
      match_status = ${p.matchStatus || 'none'},
      match_reason = ${p.matchReason == null ? null : sql.json(p.matchReason)},
      status = ${p.status},
      review_reasons = ${sql.json(p.reviewReasons || [])},
      failure_code = ${p.failureCode == null ? null : p.failureCode},
      extraction_method = ${p.extractionMethod == null ? null : p.extractionMethod},
      extraction_confidence = ${sql.json(p.fields || {})},
      extracted_text_excerpt = ${p.excerpt == null ? null : p.excerpt},
      duplicate_of_id = ${p.duplicateOfId == null ? null : p.duplicateOfId},
      duplicate_reason = ${p.duplicateReason == null ? null : p.duplicateReason},
      excluded_reason = ${p.excludedReason == null ? null : p.excludedReason},
      next_attempt_at = null
    where id = ${id} and tenant_id = ${tenantId}
    returning *`;
  return rows.length ? invoiceRow(rows[0]) : null;
}

/** Office corrections (any subset). Values are already validated by the handler. */
async function updateInvoiceFields(sql, tenantId, id, p) {
  const rows = await sql`
    update public.supplier_invoices set
      supplier_name = coalesce(${p.supplierName === undefined ? null : p.supplierName}, supplier_name),
      supplier_key = coalesce(${p.supplierKey === undefined ? null : p.supplierKey}, supplier_key),
      supplier_invoice_number = ${p.supplierInvoiceNumber === undefined ? sql`supplier_invoice_number` : p.supplierInvoiceNumber},
      document_type = coalesce(${p.documentType === undefined ? null : p.documentType}, document_type),
      invoice_date = ${p.invoiceDate === undefined ? sql`invoice_date` : p.invoiceDate},
      subtotal_ex_gst_cents = ${p.subtotalCents === undefined ? sql`subtotal_ex_gst_cents` : p.subtotalCents},
      gst_cents = ${p.gstCents === undefined ? sql`gst_cents` : p.gstCents},
      total_inc_gst_cents = ${p.totalCents === undefined ? sql`total_inc_gst_cents` : p.totalCents},
      totals_consistent = ${p.totalsConsistent === undefined ? sql`totals_consistent` : p.totalsConsistent},
      iv_reference_raw = ${p.ivReferenceRaw === undefined ? sql`iv_reference_raw` : p.ivReferenceRaw},
      iv_reference_normalised = ${p.ivReference === undefined ? sql`iv_reference_normalised` : p.ivReference},
      matched_job_legacy_id = ${p.matchedJobId === undefined ? sql`matched_job_legacy_id` : p.matchedJobId},
      matched_job_id = ${p.matchedJobUuid === undefined ? sql`matched_job_id` : p.matchedJobUuid},
      match_status = coalesce(${p.matchStatus === undefined ? null : p.matchStatus}, match_status),
      match_reason = ${p.matchReason === undefined ? sql`match_reason` : p.matchReason == null ? null : sql.json(p.matchReason)},
      status = coalesce(${p.status === undefined ? null : p.status}, status),
      review_reasons = ${p.reviewReasons === undefined ? sql`review_reasons` : sql.json(p.reviewReasons)},
      extraction_confidence = ${p.fields === undefined ? sql`extraction_confidence` : sql.json(p.fields)},
      auto_confirm_at = null,
      auto_confirm_eligible = false,
      reviewed_at = now(),
      reviewed_by_legacy_id = ${(p.actor && p.actor.id) || null},
      reviewed_by_name = ${(p.actor && p.actor.name) || null}
    where id = ${id} and tenant_id = ${tenantId}
    returning *`;
  return rows.length ? invoiceRow(rows[0]) : null;
}

async function setStatus(sql, tenantId, id, status, extra = {}) {
  const rows = await sql`
    update public.supplier_invoices set
      status = ${status},
      excluded_reason = ${extra.excludedReason === undefined ? sql`excluded_reason` : extra.excludedReason},
      duplicate_of_id = ${extra.duplicateOfId === undefined ? sql`duplicate_of_id` : extra.duplicateOfId},
      duplicate_reason = ${extra.duplicateReason === undefined ? sql`duplicate_reason` : extra.duplicateReason},
      archived_at = ${status === 'archived' ? sql`now()` : extra.clearArchive ? null : sql`archived_at`},
      archived_by_legacy_id = ${status === 'archived' ? (extra.actor && extra.actor.id) || null : sql`archived_by_legacy_id`},
      failure_code = ${extra.failureCode === undefined ? sql`failure_code` : extra.failureCode},
      next_attempt_at = ${extra.nextAttemptAt === undefined ? sql`next_attempt_at` : extra.nextAttemptAt},
      auto_confirm_at = null,
      reviewed_at = ${extra.actor ? sql`now()` : sql`reviewed_at`},
      reviewed_by_legacy_id = ${extra.actor ? extra.actor.id || null : sql`reviewed_by_legacy_id`},
      reviewed_by_name = ${extra.actor ? extra.actor.name || null : sql`reviewed_by_name`}
    where id = ${id} and tenant_id = ${tenantId}
    returning *`;
  return rows.length ? invoiceRow(rows[0]) : null;
}

// ── documents ───────────────────────────────────────────────────────────────
/** Insert a document row; returns null when the provider identity already exists (replay). */
async function addDocument(sql, tenantId, d) {
  try {
    const rows = await sql`
      insert into public.supplier_invoice_documents
        (tenant_id, invoice_id, source, kind, provider_email_id, provider_attachment_id, original_filename,
         content_type, byte_size, sha256, blob_pathname, blob_url, page_count, has_text_layer,
         uploaded_by_legacy_id, uploaded_by_name)
      values (${tenantId}, ${d.invoiceId}, ${d.source}, ${d.kind || 'pdf'}, ${d.providerEmailId || null}, ${d.providerAttachmentId || null},
              ${d.filename}, ${d.contentType}, ${d.byteSize}, ${d.sha256}, ${d.blobPathname}, ${d.blobUrl},
              ${d.pageCount == null ? null : d.pageCount}, ${d.hasTextLayer == null ? null : d.hasTextLayer},
              ${(d.uploadedBy && d.uploadedBy.id) || null}, ${(d.uploadedBy && d.uploadedBy.name) || null})
      returning *`;
    return documentRow(rows[0]);
  } catch (e) {
    if (e && e.code === UNIQUE_VIOLATION) return null;
    throw e;
  }
}

async function updateDocumentText(sql, tenantId, documentId, { pageCount, hasTextLayer }) {
  await sql`update public.supplier_invoice_documents set page_count = ${pageCount == null ? null : pageCount},
            has_text_layer = ${hasTextLayer == null ? null : hasTextLayer}
            where id = ${documentId} and tenant_id = ${tenantId}`;
}

async function findDocumentByProvider(sql, tenantId, emailId, attachmentId) {
  const rows = await sql`
    select * from public.supplier_invoice_documents
    where tenant_id = ${tenantId} and provider_email_id = ${emailId} and provider_attachment_id = ${attachmentId}`;
  return rows.length ? documentRow(rows[0]) : null;
}

/** Other invoices carrying a document with this checksum (for the duplicate rule). */
async function findInvoicesByChecksum(sql, tenantId, sha256, excludeInvoiceId) {
  const rows = await sql`
    select distinct i.id, i.status, i.created_at
    from public.supplier_invoice_documents d
    join public.supplier_invoices i on i.id = d.invoice_id
    where d.tenant_id = ${tenantId} and d.sha256 = ${sha256} and i.id <> ${excludeInvoiceId}`;
  return rows.map((r) => ({ id: r.id, status: r.status, createdAt: iso(r.created_at) }));
}

async function findInvoicesBySupplierNumber(sql, tenantId, supplierKey, number, excludeInvoiceId) {
  const rows = await sql`
    select id, status, created_at from public.supplier_invoices
    where tenant_id = ${tenantId} and supplier_key = ${supplierKey}
      and upper(regexp_replace(supplier_invoice_number, '\\s', '', 'g')) = ${number}
      and id <> ${excludeInvoiceId}`;
  return rows.map((r) => ({ id: r.id, status: r.status, createdAt: iso(r.created_at) }));
}

// ── processing ──────────────────────────────────────────────────────────────
/**
 * Atomically claim up to `limit` invoices for processing: status received
 * (and due), or processing but stale (a run that died). Bumps attempt_count.
 */
async function claimPending(sql, tenantId, { limit = 3 } = {}) {
  const stale = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
  const rows = await sql`
    update public.supplier_invoices set status = 'processing', attempt_count = attempt_count + 1
    where id in (
      select id from public.supplier_invoices
      where tenant_id = ${tenantId} and attempt_count < ${MAX_ATTEMPTS}
        and ((status = 'received' and (next_attempt_at is null or next_attempt_at <= now()))
          or (status = 'processing' and updated_at < ${stale}::timestamptz))
      order by created_at
      limit ${limit}
      for update skip locked)
    returning *`;
  return rows.map(invoiceRow);
}

/** Claim ONE specific invoice for an explicit run (upload / retry). */
async function claimOne(sql, tenantId, id, { resetAttempts = false } = {}) {
  const rows = await sql`
    update public.supplier_invoices set status = 'processing',
      attempt_count = ${resetAttempts ? 1 : sql`attempt_count + 1`}
    where id = ${id} and tenant_id = ${tenantId}
    returning *`;
  return rows.length ? invoiceRow(rows[0]) : null;
}

async function startAttempt(sql, tenantId, invoiceId, trigger) {
  const rows = await sql`
    insert into public.supplier_invoice_attempts (tenant_id, invoice_id, attempt_no, trigger)
    values (${tenantId}, ${invoiceId},
            (select coalesce(max(attempt_no), 0) + 1 from public.supplier_invoice_attempts where invoice_id = ${invoiceId}),
            ${trigger})
    returning id, attempt_no`;
  return { id: rows[0].id, attemptNo: rows[0].attempt_no };
}

async function finishAttempt(sql, attemptId, { outcome, failureCode, extractionMethod }) {
  await sql`update public.supplier_invoice_attempts set finished_at = now(), outcome = ${outcome},
            failure_code = ${failureCode || null}, extraction_method = ${extractionMethod || null}
            where id = ${attemptId}`;
}

// ── allocations (the money) ─────────────────────────────────────────────────
/**
 * Confirm: in ONE transaction insert the active allocation (the partial unique
 * index refuses a second active row), stamp the invoice confirmed, journal it.
 * Idempotent: an already-active allocation for the SAME job returns it
 * unchanged (`alreadyConfirmed: true`); for a DIFFERENT job it refuses
 * (`conflict: true`) — reassignment is its own explicit action.
 */
async function confirmAllocation(sql, tenantId, invoiceId, a) {
  return sql.begin(async (tx) => {
    const existing = await tx`
      select * from public.supplier_invoice_allocations
      where invoice_id = ${invoiceId} and tenant_id = ${tenantId} and status = 'active' for update`;
    if (existing.length) {
      const row = allocationRow(existing[0]);
      if (row.jobId === a.jobLegacyId && row.amountCents === a.amountCents) return { allocation: row, alreadyConfirmed: true };
      return { allocation: row, conflict: true };
    }
    let inserted;
    try {
      inserted = await tx`
        insert into public.supplier_invoice_allocations
          (tenant_id, invoice_id, job_legacy_id, job_id, amount_ex_gst_cents, gst_cents, total_inc_gst_cents,
           confirmed_by_legacy_id, confirmed_by_name)
        values (${tenantId}, ${invoiceId}, ${a.jobLegacyId}, ${a.jobUuid || null}, ${a.amountCents},
                ${a.gstCents == null ? null : a.gstCents}, ${a.totalCents == null ? null : a.totalCents},
                ${(a.actor && a.actor.id) || null}, ${(a.actor && a.actor.name) || null})
        returning *`;
    } catch (e) {
      if (e && e.code === UNIQUE_VIOLATION) {
        const again = await tx`select * from public.supplier_invoice_allocations where invoice_id = ${invoiceId} and status = 'active'`;
        return { allocation: allocationRow(again[0]), alreadyConfirmed: true };
      }
      throw e;
    }
    await tx`
      update public.supplier_invoices set status = 'confirmed',
        matched_job_legacy_id = ${a.jobLegacyId}, matched_job_id = ${a.jobUuid || null},
        match_status = ${a.matchStatus || 'manual'},
        confirmed_at = now(), confirmed_by_legacy_id = ${(a.actor && a.actor.id) || null},
        confirmed_by_name = ${(a.actor && a.actor.name) || null},
        reviewed_at = now(), reviewed_by_legacy_id = ${(a.actor && a.actor.id) || null},
        reviewed_by_name = ${(a.actor && a.actor.name) || null}
      where id = ${invoiceId} and tenant_id = ${tenantId}`;
    await insertEvent(tx, tenantId, invoiceId, { event: 'confirmed', actor: a.actor, detail: { jobId: a.jobLegacyId, amountCents: a.amountCents } });
    return { allocation: allocationRow(inserted[0]), alreadyConfirmed: false };
  });
}

/** Reverse the active allocation (if any) inside `tx`. Returns the reversed row or null. */
async function reverseActiveAllocationTx(tx, tenantId, invoiceId, { actor, reason }) {
  const rows = await tx`
    update public.supplier_invoice_allocations set status = 'reversed', reversed_at = now(),
      reversed_by_legacy_id = ${(actor && actor.id) || null}, reversed_by_name = ${(actor && actor.name) || null},
      reversal_reason = ${reason || null}
    where invoice_id = ${invoiceId} and tenant_id = ${tenantId} and status = 'active'
    returning *`;
  return rows.length ? allocationRow(rows[0]) : null;
}

/** Exclude / archive / mark-duplicate: one transaction — reverse any active allocation, set status, journal. */
async function transitionWithReversal(sql, tenantId, invoiceId, { status, actor, event, detail, extra }) {
  return sql.begin(async (tx) => {
    const reversed = await reverseActiveAllocationTx(tx, tenantId, invoiceId, { actor, reason: status });
    const invoice = await setStatus(tx, tenantId, invoiceId, status, { ...(extra || {}), actor });
    await insertEvent(tx, tenantId, invoiceId, { event, actor, detail: { ...(detail || {}), reversedAllocationId: reversed ? reversed.id : null } });
    return { invoice, reversed };
  });
}

/** Reassign a confirmed invoice to another job: reverse + insert in one transaction. */
async function reassignAllocation(sql, tenantId, invoiceId, a) {
  return sql.begin(async (tx) => {
    const previous = await reverseActiveAllocationTx(tx, tenantId, invoiceId, { actor: a.actor, reason: 'reassigned' });
    const inserted = await tx`
      insert into public.supplier_invoice_allocations
        (tenant_id, invoice_id, job_legacy_id, job_id, amount_ex_gst_cents, gst_cents, total_inc_gst_cents,
         confirmed_by_legacy_id, confirmed_by_name)
      values (${tenantId}, ${invoiceId}, ${a.jobLegacyId}, ${a.jobUuid || null}, ${a.amountCents},
              ${a.gstCents == null ? null : a.gstCents}, ${a.totalCents == null ? null : a.totalCents},
              ${(a.actor && a.actor.id) || null}, ${(a.actor && a.actor.name) || null})
      returning *`;
    await tx`
      update public.supplier_invoices set matched_job_legacy_id = ${a.jobLegacyId}, matched_job_id = ${a.jobUuid || null},
        match_status = 'manual', reviewed_at = now(),
        reviewed_by_legacy_id = ${(a.actor && a.actor.id) || null}, reviewed_by_name = ${(a.actor && a.actor.name) || null}
      where id = ${invoiceId} and tenant_id = ${tenantId}`;
    await insertEvent(tx, tenantId, invoiceId, {
      event: 'reassigned', actor: a.actor,
      detail: { fromJobId: previous ? previous.jobId : null, toJobId: a.jobLegacyId, amountCents: a.amountCents },
    });
    return { allocation: allocationRow(inserted[0]), previous };
  });
}

/** The job's supplier-invoice figure: SUM of active allocations (never cached). */
async function jobSummary(sql, tenantId, jobLegacyId) {
  const [alloc, awaiting] = await Promise.all([
    sql`select coalesce(sum(amount_ex_gst_cents), 0)::bigint as total, count(*)::int as n
        from public.supplier_invoice_allocations
        where tenant_id = ${tenantId} and job_legacy_id = ${jobLegacyId} and status = 'active'`,
    sql`select count(*)::int as n from public.supplier_invoices
        where tenant_id = ${tenantId} and matched_job_legacy_id = ${jobLegacyId} and status in ('matched','needs_review')`,
  ]);
  return { jobId: jobLegacyId, confirmedCents: cents(alloc[0].total), confirmedCount: Number(alloc[0].n), awaitingCount: Number(awaiting[0].n) };
}

/** Same figure for many jobs at once (list surfaces). */
async function jobSummaries(sql, tenantId, jobLegacyIds) {
  if (!Array.isArray(jobLegacyIds) || !jobLegacyIds.length) return {};
  const rows = await sql`
    select job_legacy_id, coalesce(sum(amount_ex_gst_cents), 0)::bigint as total, count(*)::int as n
    from public.supplier_invoice_allocations
    where tenant_id = ${tenantId} and status = 'active' and job_legacy_id in ${sql(jobLegacyIds)}
    group by job_legacy_id`;
  const out = {};
  for (const r of rows) out[r.job_legacy_id] = { confirmedCents: cents(r.total), confirmedCount: Number(r.n) };
  return out;
}

// ── automatic booking (docs/invoice-capture.md "Auto-booking") ──────────────
/** Invoices of this supplier a PERSON confirmed (the trust bootstrap). */
async function supplierHumanConfirmedCount(sql, tenantId, supplierKey) {
  if (!supplierKey) return 0;
  const rows = await sql`
    select count(*)::int as n from public.supplier_invoices
    where tenant_id = ${tenantId} and supplier_key = ${supplierKey} and status = 'confirmed'
      and confirmed_by_legacy_id is distinct from '__auto__'`;
  return Number(rows[0].n);
}

/** Does this supplier already have an ACTIVE confirmed invoice allocation on this job? */
async function supplierConfirmedOnJob(sql, tenantId, supplierKey, jobLegacyId) {
  if (!supplierKey || !jobLegacyId) return false;
  const rows = await sql`
    select 1 from public.supplier_invoice_allocations a
    join public.supplier_invoices i on i.id = a.invoice_id
    where a.tenant_id = ${tenantId} and a.job_legacy_id = ${jobLegacyId} and a.status = 'active'
      and i.supplier_key = ${supplierKey} and i.document_type in ('invoice','tax_invoice')
    limit 1`;
  return rows.length > 0;
}

async function getSupplierPref(sql, tenantId, supplierKey) {
  if (!supplierKey) return { alwaysReview: false, setBy: null, setAt: null };
  const rows = await sql`select * from public.supplier_invoice_supplier_prefs where tenant_id = ${tenantId} and supplier_key = ${supplierKey}`;
  return rows.length ? { alwaysReview: rows[0].always_review === true, setBy: rows[0].set_by_name || null, setAt: iso(rows[0].set_at) } : { alwaysReview: false, setBy: null, setAt: null };
}

async function setSupplierPref(sql, tenantId, supplierKey, { alwaysReview, actor }) {
  await sql`
    insert into public.supplier_invoice_supplier_prefs (tenant_id, supplier_key, always_review, set_by_name)
    values (${tenantId}, ${supplierKey}, ${!!alwaysReview}, ${(actor && actor.name) || null})
    on conflict (tenant_id, supplier_key) do update
      set always_review = excluded.always_review, set_by_name = excluded.set_by_name, set_at = now()`;
  return getSupplierPref(sql, tenantId, supplierKey);
}

/** Record the eligibility verdict (and the deadline when booking is switched on). */
async function scheduleAutoConfirm(sql, tenantId, id, { eligible, checks, at }) {
  const rows = await sql`
    update public.supplier_invoices set
      auto_confirm_eligible = ${!!eligible},
      auto_confirm_checks = ${sql.json(checks || [])},
      auto_confirm_at = ${at == null ? null : at}
    where id = ${id} and tenant_id = ${tenantId} and status = 'matched'
    returning *`;
  return rows.length ? invoiceRow(rows[0]) : null;
}

/** A person holds it: never books automatically until a person acts. */
async function holdInvoice(sql, tenantId, id, actor) {
  const rows = await sql`
    update public.supplier_invoices set auto_confirm_at = null, held_at = now(), held_by_name = ${(actor && actor.name) || null}
    where id = ${id} and tenant_id = ${tenantId}
    returning *`;
  return rows.length ? invoiceRow(rows[0]) : null;
}

/** Atomically claim due auto-bookings (the claim clears the deadline so a retry never double-books). */
async function claimAutoConfirmDue(sql, tenantId, { limit = 10, now } = {}) {
  const at = now || new Date().toISOString();
  const rows = await sql`
    update public.supplier_invoices set auto_confirm_at = null
    where id in (
      select id from public.supplier_invoices
      where tenant_id = ${tenantId} and status = 'matched' and auto_confirm_eligible and held_at is null
        and auto_confirm_at is not null and auto_confirm_at <= ${at}::timestamptz
      order by auto_confirm_at
      limit ${limit}
      for update skip locked)
    returning *`;
  return rows.map(invoiceRow);
}

/** Everything the weekly digest needs, in one place. */
async function digestStats(sql, tenantId, { since }) {
  const rowOf = (r) => ({ id: r.id, supplierName: r.supplier_name, supplierInvoiceNumber: r.supplier_invoice_number, matchedJobId: r.matched_job_legacy_id, amountCents: cents(r.amount) });
  const [captured, auto, human, pending, soon, failed, setAside, stuck, last] = await Promise.all([
    sql`select count(*)::int as n from public.supplier_invoices where tenant_id = ${tenantId} and created_at >= ${since}::timestamptz`,
    sql`select i.id, i.supplier_name, i.supplier_invoice_number, i.matched_job_legacy_id, a.amount_ex_gst_cents as amount
        from public.supplier_invoice_allocations a join public.supplier_invoices i on i.id = a.invoice_id
        where a.tenant_id = ${tenantId} and a.confirmed_at >= ${since}::timestamptz and a.confirmed_by_legacy_id = '__auto__' order by a.confirmed_at`,
    sql`select i.id, i.supplier_name, i.supplier_invoice_number, i.matched_job_legacy_id, a.amount_ex_gst_cents as amount
        from public.supplier_invoice_allocations a join public.supplier_invoices i on i.id = a.invoice_id
        where a.tenant_id = ${tenantId} and a.confirmed_at >= ${since}::timestamptz and a.confirmed_by_legacy_id is distinct from '__auto__' order by a.confirmed_at`,
    sql`select id, supplier_name, supplier_invoice_number, matched_job_legacy_id, subtotal_ex_gst_cents as amount
        from public.supplier_invoices where tenant_id = ${tenantId} and status in ('needs_review','matched') and (auto_confirm_at is null or held_at is not null) order by created_at limit 50`,
    sql`select id, supplier_name, supplier_invoice_number, matched_job_legacy_id, subtotal_ex_gst_cents as amount
        from public.supplier_invoices where tenant_id = ${tenantId} and status = 'matched' and auto_confirm_eligible and auto_confirm_at is not null and held_at is null order by auto_confirm_at limit 50`,
    sql`select count(*)::int as n from public.supplier_invoices where tenant_id = ${tenantId} and status = 'failed'`,
    sql`select count(*)::int as n from public.supplier_invoices where tenant_id = ${tenantId} and status = 'excluded' and excluded_reason like 'not_an_invoice:%' and created_at >= ${since}::timestamptz`,
    sql`select count(*)::int as n from public.supplier_invoices where tenant_id = ${tenantId} and status in ('received','processing') and created_at < now() - interval '1 day'`,
    sql`select max(created_at) as last, count(*)::int as n from public.supplier_invoice_inbound_events where status in ('received','processed','quarantined')`,
  ]);
  return {
    capturedCount: Number(captured[0].n),
    autoBooked: auto.map(rowOf),
    humanBooked: human.map(rowOf),
    pending: pending.map(rowOf),
    bookingSoon: soon.map(rowOf),
    failedCount: Number(failed[0].n),
    setAsideCount: Number(setAside[0].n),
    stuckCount: Number(stuck[0].n),
    lastReceivedAt: iso(last[0].last),
    everReceived: Number(last[0].n) > 0,
  };
}

// ── events ──────────────────────────────────────────────────────────────────
async function insertEvent(sql, tenantId, invoiceId, { event, actor, detail }) {
  await sql`
    insert into public.supplier_invoice_events (tenant_id, invoice_id, event, actor_legacy_id, actor_name, actor_role, detail)
    values (${tenantId}, ${invoiceId}, ${event}, ${(actor && actor.id) || null}, ${(actor && actor.name) || null},
            ${(actor && actor.role) || null}, ${sql.json(detail || {})})`;
}

// ── inbound (webhook) events ────────────────────────────────────────────────
/** Record a webhook delivery once. Returns { inserted: false } on replay. */
async function recordInboundEvent(sql, e) {
  try {
    const rows = await sql`
      insert into public.supplier_invoice_inbound_events
        (tenant_id, svix_message_id, provider_email_id, to_address_matched, from_address, subject, attachment_count, status, failure_code)
      values (${e.tenantId || null}, ${e.svixId}, ${e.emailId || null}, ${!!e.toMatched}, ${e.from || null},
              ${e.subject || null}, ${e.attachmentCount || 0}, ${e.status}, ${e.failureCode || null})
      returning id`;
    return { inserted: true, id: rows[0].id };
  } catch (err) {
    if (err && err.code === UNIQUE_VIOLATION) return { inserted: false };
    throw err;
  }
}

async function finishInboundEvent(sql, svixId, { status, failureCode }) {
  await sql`update public.supplier_invoice_inbound_events set status = ${status}, failure_code = ${failureCode || null}, processed_at = now()
            where svix_message_id = ${svixId}`;
}

async function listQuarantined(sql, { limit = 20 } = {}) {
  const rows = await sql`select * from public.supplier_invoice_inbound_events where status = 'quarantined' order by created_at limit ${limit}`;
  return rows.map((r) => ({ id: r.id, svixId: r.svix_message_id, emailId: r.provider_email_id, subject: r.subject, from: r.from_address, attachmentCount: Number(r.attachment_count || 0), createdAt: iso(r.created_at) }));
}

async function inboundStats(sql) {
  const rows = await sql`select status, count(*)::int as n, max(created_at) as last from public.supplier_invoice_inbound_events group by status`;
  const out = { quarantined: 0, processed: 0, failed: 0, ignored: 0, received: 0, lastAt: null };
  for (const r of rows) {
    out[r.status] = Number(r.n);
    const last = iso(r.last);
    if (last && (!out.lastAt || last > out.lastAt)) out.lastAt = last;
  }
  return out;
}

async function invoiceIdsForEmail(sql, tenantId, emailId) {
  const rows = await sql`select id from public.supplier_invoices where tenant_id = ${tenantId} and source_email_id = ${emailId}`;
  return rows.map((r) => r.id);
}

module.exports = {
  TENANT_SLUG,
  MAX_ATTEMPTS,
  resolveTenant,
  resolveJobUuid,
  createInvoice,
  createInvoiceWithDocument,
  getInvoiceRow,
  getInvoiceDetail,
  getDocumentWithBlob,
  listInvoices,
  countsByStatus,
  listSuppliers,
  applyExtraction,
  updateInvoiceFields,
  setStatus,
  addDocument,
  updateDocumentText,
  findDocumentByProvider,
  findInvoicesByChecksum,
  findInvoicesBySupplierNumber,
  listSupplierInvoices,
  claimPending,
  claimOne,
  startAttempt,
  finishAttempt,
  confirmAllocation,
  transitionWithReversal,
  reassignAllocation,
  jobSummary,
  jobSummaries,
  insertEvent,
  supplierHumanConfirmedCount,
  supplierConfirmedOnJob,
  getSupplierPref,
  setSupplierPref,
  scheduleAutoConfirm,
  holdInvoice,
  claimAutoConfirmDue,
  digestStats,
  recordInboundEvent,
  finishInboundEvent,
  listQuarantined,
  inboundStats,
  invoiceIdsForEmail,
};
