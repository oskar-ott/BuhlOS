'use strict';

// Customer stage-invoice Postgres store (migration
// 20261122100000_customer_invoices.sql). House idiom, same as
// api/_lib/invoices/store.js: every function takes the Postgres.js `sql`
// handle the handler opened through the env guard (api/_lib/supabase-db
// getDb), the tenant is resolved once per request, every query is
// tenant-scoped, and errors THROW (the handler maps them to stable codes).
//
// Money columns are bigint → Postgres.js returns strings; every read maps
// them back to integer cents (Number) so the API never emits a string amount.
//
// Concurrency: rows carry `version`; every edit is a compare-and-swap on it
// (StoreConflict when someone else got there first). Only `planned` rows are
// editable here — a sent stage is frozen (ADR rule 7).

const TENANT_SLUG = 'buhl';

class StoreConflict extends Error {
  /** @param {'version'|'not_planned'|'not_found'} reason */
  constructor(reason) {
    super(`customer invoice store conflict: ${reason}`);
    this.name = 'StoreConflict';
    this.reason = reason;
  }
}

function cents(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function int(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
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

// ── row mappers ─────────────────────────────────────────────────────────────
function profileRow(r) {
  if (!r) return null;
  return {
    jobId: r.job_legacy_id,
    xeroContactId: r.xero_contact_id,
    xeroContactName: r.xero_contact_name,
    externalTenantId: r.external_tenant_id,
    retentionBp: int(r.retention_bp) || 0,
    paymentClaim: r.payment_claim === true,
    version: int(r.version),
    updatedBy: r.updated_by_name,
    updatedAt: iso(r.updated_at),
  };
}

function extraLinesOf(v) {
  const raw = json(v, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((l) => l && typeof l.description === 'string')
    .map((l) => ({
      description: l.description,
      amountCents: cents(l.amountCents),
      // set when the line bills an approved variation (#1163)
      ...(typeof l.variationId === 'string' && l.variationId ? { variationId: l.variationId } : {}),
    }))
    .filter((l) => l.amountCents != null);
}

/** An itemised invoice's lines, as stored (api/_lib/customer-invoices/amounts.js
 *  `itemsOf` is the one place they are normalised and priced). */
function itemsJson(v) {
  const raw = json(v, []);
  return Array.isArray(raw) ? raw.filter((it) => it && typeof it.description === 'string') : [];
}

function invoiceRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    jobId: r.job_legacy_id,
    kind: r.kind,
    sortOrder: int(r.sort_order) || 0,
    seq: int(r.seq),
    invoiceNumber: r.invoice_number,
    title: r.title,
    basis: r.basis,
    percentBp: int(r.percent_bp),
    amountCents: cents(r.amount_cents),
    extraLines: extraLinesOf(r.extra_lines),
    items: itemsJson(r.items),
    retentionBp: int(r.retention_bp),
    plannedDate: dateOnly(r.planned_date),
    note: r.note,
    grossCents: cents(r.gross_cents),
    retentionCents: cents(r.retention_cents),
    netCents: cents(r.net_cents),
    invoiceDate: dateOnly(r.invoice_date),
    dueDate: dateOnly(r.due_date),
    reference: r.reference,
    contentHash: r.content_hash,
    sentFooter: r.sent_footer || null,
    state: r.state,
    failureCategory: r.failure_category,
    failureDetail: r.failure_detail,
    externalTenantId: r.external_tenant_id,
    xeroContactId: r.xero_contact_id,
    xeroContactName: r.xero_contact_name,
    xeroInvoiceId: r.xero_invoice_id,
    xeroStatus: r.xero_status,
    xeroSubtotalCents: cents(r.xero_subtotal_cents),
    xeroTaxCents: cents(r.xero_tax_cents),
    xeroTotalCents: cents(r.xero_total_cents),
    xeroAmountDueCents: cents(r.xero_amount_due_cents),
    xeroAmountPaidCents: cents(r.xero_amount_paid_cents),
    xeroAmountCreditedCents: cents(r.xero_amount_credited_cents),
    xeroDueDate: dateOnly(r.xero_due_date),
    xeroFullyPaidOn: dateOnly(r.xero_fully_paid_on),
    xeroUpdatedAt: iso(r.xero_updated_at),
    lastCheckedAt: iso(r.last_checked_at),
    drift: json(r.drift, null),
    // set when a dead (deleted / voided in Xero) stage has been raised again
    replacedById: r.replaced_by_id || null,
    version: int(r.version),
    createdBy: r.created_by_name,
    sentBy: r.sent_by_name,
    sentAt: iso(r.sent_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function eventRow(r) {
  return {
    id: r.id,
    invoiceId: r.invoice_id,
    event: r.event,
    actor: r.actor_name,
    detail: json(r.detail, {}),
    at: iso(r.created_at),
  };
}

// ── events ──────────────────────────────────────────────────────────────────
async function insertEvent(sql, tenantId, e) {
  await sql`
    insert into public.customer_invoice_events
      (tenant_id, invoice_id, job_legacy_id, attempt_id, event, detail, actor_legacy_id, actor_name)
    values (${tenantId}, ${e.invoiceId || null}, ${e.jobId || null}, ${e.attemptId || null}, ${e.event},
            ${sql.json(e.detail || {})}, ${(e.actor && e.actor.id) || null}, ${(e.actor && e.actor.name) || null})`;
}

async function listJobEvents(sql, tenantId, jobLegacyId, { limit = 100 } = {}) {
  const rows = await sql`
    select id, invoice_id, event, actor_name, detail, created_at
    from public.customer_invoice_events
    where tenant_id = ${tenantId} and job_legacy_id = ${jobLegacyId}
    order by created_at desc
    limit ${limit}`;
  return rows.map(eventRow);
}

// ── per-job profile ─────────────────────────────────────────────────────────
async function getProfile(sql, tenantId, jobLegacyId) {
  const rows = await sql`
    select * from public.customer_invoice_job_profiles
    where tenant_id = ${tenantId} and job_legacy_id = ${jobLegacyId}`;
  return rows.length ? profileRow(rows[0]) : null;
}

/**
 * Create or update a job's profile. `patch` carries only the fields being
 * changed. `expectedVersion` is null for a first save (no row yet) and the
 * row's current version otherwise; a mismatch throws StoreConflict('version').
 */
async function saveProfile(sql, tenantId, jobLegacyId, patch, { expectedVersion, actor }) {
  return sql.begin(async (tx) => {
    const cur = await tx`
      select * from public.customer_invoice_job_profiles
      where tenant_id = ${tenantId} and job_legacy_id = ${jobLegacyId}
      for update`;
    const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
    let row;
    if (!cur.length) {
      if (expectedVersion != null) throw new StoreConflict('version');
      const ins = await tx`
        insert into public.customer_invoice_job_profiles
          (tenant_id, job_legacy_id, xero_contact_id, xero_contact_name, external_tenant_id,
           retention_bp, payment_claim, updated_by_legacy_id, updated_by_name)
        values (${tenantId}, ${jobLegacyId},
                ${has('xeroContactId') ? patch.xeroContactId : null},
                ${has('xeroContactName') ? patch.xeroContactName : null},
                ${has('externalTenantId') ? patch.externalTenantId : null},
                ${has('retentionBp') ? patch.retentionBp : 0},
                ${has('paymentClaim') ? patch.paymentClaim === true : false},
                ${(actor && actor.id) || null}, ${(actor && actor.name) || null})
        returning *`;
      row = ins[0];
    } else {
      const c = cur[0];
      if (Number(c.version) !== Number(expectedVersion)) throw new StoreConflict('version');
      const upd = await tx`
        update public.customer_invoice_job_profiles set
          xero_contact_id    = ${has('xeroContactId') ? patch.xeroContactId : c.xero_contact_id},
          xero_contact_name  = ${has('xeroContactName') ? patch.xeroContactName : c.xero_contact_name},
          external_tenant_id = ${has('externalTenantId') ? patch.externalTenantId : c.external_tenant_id},
          retention_bp       = ${has('retentionBp') ? patch.retentionBp : c.retention_bp},
          payment_claim      = ${has('paymentClaim') ? patch.paymentClaim === true : c.payment_claim},
          version            = version + 1,
          updated_by_legacy_id = ${(actor && actor.id) || null},
          updated_by_name    = ${(actor && actor.name) || null}
        where id = ${c.id} and tenant_id = ${tenantId}
        returning *`;
      row = upd[0];
    }
    await insertEvent(tx, tenantId, {
      jobId: jobLegacyId, event: 'profile_updated', actor,
      detail: { fields: Object.keys(patch).sort() },
    });
    return profileRow(row);
  });
}

// ── stage invoices ──────────────────────────────────────────────────────────
async function listJobInvoices(sql, tenantId, jobLegacyId) {
  const rows = await sql`
    select * from public.customer_invoices
    where tenant_id = ${tenantId} and job_legacy_id = ${jobLegacyId} and state <> 'cancelled'
    order by sort_order asc, created_at asc`;
  return rows.map(invoiceRow);
}

async function getInvoice(sql, tenantId, id) {
  const rows = await sql`
    select * from public.customer_invoices where tenant_id = ${tenantId} and id = ${id}`;
  return rows.length ? invoiceRow(rows[0]) : null;
}

/**
 * One writer at a time per job for anything that decides WHAT AN INVOICE
 * BILLS (the job's hours, materials, variations). Taken inside the caller's
 * transaction and released at commit / rollback, so "is this already on an
 * invoice?" and the write that depends on the answer can never interleave
 * with another request's.
 */
async function lockJobLines(tx, tenantId, jobLegacyId) {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`customer-invoice-lines:${tenantId}:${jobLegacyId}`}, 0))`;
}

/**
 * Add a planned stage at the end of the job's list.
 *
 * `opts.prepare(tx)` — when given — runs INSIDE the transaction, under the
 * job's lines lock, and returns the content to store. It is where an itemised
 * invoice's lines are checked against what other invoices already bill.
 */
async function createStage(sql, tenantId, jobLegacyId, s0, actor, opts = {}) {
  return sql.begin(async (tx) => {
    let s = s0;
    if (opts.prepare) {
      await lockJobLines(tx, tenantId, jobLegacyId);
      s = await opts.prepare(tx);
    }
    const next = await tx`
      select coalesce(max(sort_order), 0) + 1 as n
      from public.customer_invoices
      where tenant_id = ${tenantId} and job_legacy_id = ${jobLegacyId}`;
    const rows = await tx`
      insert into public.customer_invoices
        (tenant_id, job_legacy_id, kind, sort_order, title, basis, percent_bp, amount_cents,
         extra_lines, items, retention_bp, planned_date, note, created_by_legacy_id, created_by_name)
      values (${tenantId}, ${jobLegacyId}, ${s.kind || 'stage'}, ${Number(next[0].n)}, ${s.title}, ${s.basis},
              ${s.basis === 'percent' ? s.percentBp : null}, ${s.basis === 'amount' ? s.amountCents : null},
              ${tx.json(s.extraLines || [])}, ${tx.json(s.items || [])}, ${s.retentionBp == null ? null : s.retentionBp},
              ${s.plannedDate || null}, ${s.note || null},
              ${(actor && actor.id) || null}, ${(actor && actor.name) || null})
      returning *`;
    const row = invoiceRow(rows[0]);
    await insertEvent(tx, tenantId, {
      invoiceId: row.id, jobId: jobLegacyId, event: 'created', actor,
      detail: { kind: row.kind, basis: row.basis },
    });
    return row;
  });
}

/** Why a guarded write matched no row: gone, no longer planned, or moved on. */
async function conflictReason(tx, tenantId, id) {
  const cur = await tx`
    select state from public.customer_invoices where tenant_id = ${tenantId} and id = ${id}`;
  if (!cur.length) return 'not_found';
  return cur[0].state === 'planned' ? 'version' : 'not_planned';
}

/** Replace a PLANNED stage's content (compare-and-swap on version).
 *  `prepare(tx)` + `jobId`: as createStage — checked under the job's lock. */
async function updateStage(sql, tenantId, id, s0, { expectedVersion, actor, prepare, jobId }) {
  return sql.begin(async (tx) => {
    let s = s0;
    if (prepare) {
      await lockJobLines(tx, tenantId, jobId);
      s = await prepare(tx);
    }
    const rows = await tx`
      update public.customer_invoices set
        kind         = ${s.kind || 'stage'},
        title        = ${s.title},
        basis        = ${s.basis},
        percent_bp   = ${s.basis === 'percent' ? s.percentBp : null},
        amount_cents = ${s.basis === 'amount' ? s.amountCents : null},
        extra_lines  = ${tx.json(s.extraLines || [])},
        items        = ${tx.json(s.items || [])},
        retention_bp = ${s.retentionBp == null ? null : s.retentionBp},
        planned_date = ${s.plannedDate || null},
        note         = ${s.note || null},
        version      = version + 1
      where tenant_id = ${tenantId} and id = ${id} and state = 'planned' and version = ${expectedVersion}
      returning *`;
    if (!rows.length) throw new StoreConflict(await conflictReason(tx, tenantId, id));
    const row = invoiceRow(rows[0]);
    await insertEvent(tx, tenantId, { invoiceId: row.id, jobId: row.jobId, event: 'edited', actor, detail: {} });
    return row;
  });
}

/**
 * Remove a PLANNED stage. It was never sent, so nothing exists in Xero and
 * the row is deleted outright; the `removed` event is kept at job level
 * (its per-invoice events go with the row).
 */
async function removeStage(sql, tenantId, id, { expectedVersion, actor }) {
  return sql.begin(async (tx) => {
    const rows = await tx`
      delete from public.customer_invoices
      where tenant_id = ${tenantId} and id = ${id} and state = 'planned' and version = ${expectedVersion}
      returning id, job_legacy_id, title, kind`;
    if (!rows.length) throw new StoreConflict(await conflictReason(tx, tenantId, id));
    await insertEvent(tx, tenantId, {
      jobId: rows[0].job_legacy_id, event: 'removed', actor,
      detail: { title: rows[0].title, kind: rows[0].kind },
    });
    return { id: rows[0].id, jobId: rows[0].job_legacy_id };
  });
}

/**
 * The most recently linked Xero contact among OTHER jobs (same client name,
 * chosen by the caller) in the given organisation — offered as a suggestion
 * when a job has no link yet. A person still confirms it; it is never applied
 * on its own (ADR rule 8).
 */
async function latestContactAmongJobs(sql, tenantId, jobLegacyIds, externalTenantId) {
  if (!Array.isArray(jobLegacyIds) || !jobLegacyIds.length || !externalTenantId) return null;
  const rows = await sql`
    select xero_contact_id, xero_contact_name, job_legacy_id
    from public.customer_invoice_job_profiles
    where tenant_id = ${tenantId}
      and job_legacy_id in ${sql(jobLegacyIds)}
      and external_tenant_id = ${externalTenantId}
      and xero_contact_id is not null
    order by updated_at desc
    limit 1`;
  if (!rows.length) return null;
  return { id: rows[0].xero_contact_id, name: rows[0].xero_contact_name, fromJobId: rows[0].job_legacy_id };
}

// ── org-level defaults ──────────────────────────────────────────────────────
function settingsRow(r) {
  if (!r) return null;
  return {
    externalTenantId: r.external_tenant_id,
    salesAccountCode: r.sales_account_code,
    salesAccountName: r.sales_account_name,
    taxType: r.tax_type,
    taxName: r.tax_name,
    taxRateBp: int(r.tax_rate_bp),
    paymentTermsDays: int(r.payment_terms_days),
    version: int(r.version),
    updatedBy: r.updated_by_name,
    updatedAt: iso(r.updated_at),
  };
}

/** The defaults chosen for ONE Xero organisation, or null when none are saved. */
async function getSettings(sql, tenantId, externalTenantId) {
  if (!externalTenantId) return null;
  const rows = await sql`
    select * from public.customer_invoice_settings
    where tenant_id = ${tenantId} and external_tenant_id = ${externalTenantId}`;
  return rows.length ? settingsRow(rows[0]) : null;
}

/**
 * Save the defaults for one organisation (whole-row replace: the three are
 * chosen together on one panel). `expectedVersion` is null for a first save.
 */
async function saveSettings(sql, tenantId, externalTenantId, v, { expectedVersion, actor }) {
  return sql.begin(async (tx) => {
    const cur = await tx`
      select id, version from public.customer_invoice_settings
      where tenant_id = ${tenantId} and external_tenant_id = ${externalTenantId}
      for update`;
    let row;
    if (!cur.length) {
      if (expectedVersion != null) throw new StoreConflict('version');
      const ins = await tx`
        insert into public.customer_invoice_settings
          (tenant_id, external_tenant_id, sales_account_code, sales_account_name, tax_type, tax_name,
           tax_rate_bp, payment_terms_days, updated_by_legacy_id, updated_by_name)
        values (${tenantId}, ${externalTenantId}, ${v.salesAccountCode}, ${v.salesAccountName}, ${v.taxType}, ${v.taxName},
                ${v.taxRateBp}, ${v.paymentTermsDays}, ${(actor && actor.id) || null}, ${(actor && actor.name) || null})
        returning *`;
      row = ins[0];
    } else {
      if (Number(cur[0].version) !== Number(expectedVersion)) throw new StoreConflict('version');
      const upd = await tx`
        update public.customer_invoice_settings set
          sales_account_code = ${v.salesAccountCode},
          sales_account_name = ${v.salesAccountName},
          tax_type           = ${v.taxType},
          tax_name           = ${v.taxName},
          tax_rate_bp        = ${v.taxRateBp},
          payment_terms_days = ${v.paymentTermsDays},
          version            = version + 1,
          updated_by_legacy_id = ${(actor && actor.id) || null},
          updated_by_name    = ${(actor && actor.name) || null}
        where id = ${cur[0].id} and tenant_id = ${tenantId}
        returning *`;
      row = upd[0];
    }
    await insertEvent(tx, tenantId, { event: 'settings_updated', actor, detail: { externalTenantId } });
    return settingsRow(row);
  });
}

/** True when every default an invoice needs has been chosen. */
function settingsComplete(s) {
  return !!(s && s.salesAccountCode && s.taxType && Number.isInteger(s.taxRateBp) && Number.isInteger(s.paymentTermsDays));
}

// ── sending (#1150) ─────────────────────────────────────────────────────────
// A stage's journey to Xero, in the database:
//   planned ──beginSend──▶ sending ──markAccepted──▶ sent
//                             │  └──markFailed──▶ failed   (Xero said no; nothing exists there)
//                             └──noteUnknown──▶ sending    (no answer; may or may not exist)
//   sending/failed ──resetToPlanned──▶ planned   (only when Xero has nothing under the number)
//   failed ──raiseAgain──▶ cancelled (number kept, burned) + a new planned copy
// Every step is a guarded UPDATE: it changes the row only from the state it
// expects, so two requests can never both win.

const UNIQUE_VIOLATION = '23505';

/** What the next sent stage on this job would be numbered (a peek for the
 *  preview — the real allocation happens inside beginSend's transaction). */
async function peekNextSeq(sql, tenantId, jobLegacyId) {
  const rows = await sql`
    select coalesce(max(seq), 0) + 1 as n
    from public.customer_invoices
    where tenant_id = ${tenantId} and job_legacy_id = ${jobLegacyId}`;
  return Number(rows[0].n);
}

/**
 * Claim a PLANNED stage for sending: allocate its number, freeze what will be
 * invoiced, move it to `sending`. One transaction, serialised per job so two
 * stages sent at once can never take the same number; the unique indexes are
 * the backstop.
 *
 * `snap.build(invoiceNumber)` is called inside the transaction and returns the
 * content hash of the body that will be sent under that number.
 */
async function beginSend(sql, tenantId, id, snap, { expectedVersion, actor }) {
  try {
    return await sql.begin(async (tx) => {
      const cur = await tx`
        select id, job_legacy_id, state, version from public.customer_invoices
        where tenant_id = ${tenantId} and id = ${id}
        for update`;
      if (!cur.length) throw new StoreConflict('not_found');
      if (cur[0].state !== 'planned') throw new StoreConflict('not_planned');
      if (Number(cur[0].version) !== Number(expectedVersion)) throw new StoreConflict('version');
      const job = cur[0].job_legacy_id;
      // One send at a time per job (released at commit / rollback).
      await tx`select pg_advisory_xact_lock(hashtextextended(${`customer-invoice-seq:${tenantId}:${job}`}, 0))`;
      const next = await tx`
        select coalesce(max(seq), 0) + 1 as n
        from public.customer_invoices
        where tenant_id = ${tenantId} and job_legacy_id = ${job}`;
      const seq = Number(next[0].n);
      const invoiceNumber = `${snap.jobCode}-${seq}`;
      const contentHash = snap.build(invoiceNumber);
      const rows = await tx`
        update public.customer_invoices set
          state              = 'sending',
          seq                = ${seq},
          invoice_number     = ${invoiceNumber},
          gross_cents        = ${snap.grossCents},
          retention_bp       = ${snap.retentionBp},
          retention_cents    = ${snap.retentionCents},
          net_cents          = ${snap.netCents},
          invoice_date       = ${snap.invoiceDate},
          due_date           = ${snap.dueDate},
          reference          = ${snap.reference},
          sent_footer        = ${snap.footer || null},
          content_hash       = ${contentHash},
          external_tenant_id = ${snap.externalTenantId},
          xero_contact_id    = ${snap.xeroContactId},
          xero_contact_name  = ${snap.xeroContactName},
          failure_category   = null,
          failure_detail     = null,
          sent_by_legacy_id  = ${(actor && actor.id) || null},
          sent_by_name       = ${(actor && actor.name) || null},
          version            = version + 1
        where tenant_id = ${tenantId} and id = ${id}
        returning *`;
      return invoiceRow(rows[0]);
    });
  } catch (e) {
    if (e && e.code === UNIQUE_VIOLATION) throw new StoreConflict('number_clash');
    throw e;
  }
}

/** One immutable row per attempt to reach Xero, written with its outcome. */
async function insertAttempt(sql, tenantId, a) {
  await sql`
    insert into public.customer_invoice_attempts
      (id, tenant_id, invoice_id, external_tenant_id, invoice_number, content_hash, request_hash,
       idempotency_key, xero_invoice_id, correlation_id, http_status, outcome, error_category,
       error_detail, actor_legacy_id, actor_name)
    values (${a.id}, ${tenantId}, ${a.invoiceId}, ${a.externalTenantId}, ${a.invoiceNumber}, ${a.contentHash},
            ${a.requestHash || null}, ${a.idempotencyKey || null}, ${a.xeroInvoiceId || null},
            ${a.correlationId || null}, ${a.httpStatus == null ? null : a.httpStatus}, ${a.outcome},
            ${a.errorCategory || null}, ${a.errorDetail == null ? null : String(a.errorDetail).slice(0, 1000)},
            ${(a.actor && a.actor.id) || null}, ${(a.actor && a.actor.name) || null})`;
}

async function listAttempts(sql, tenantId, invoiceId) {
  const rows = await sql`
    select id, invoice_number, outcome, xero_invoice_id, idempotency_key, request_hash, http_status,
           error_category, error_detail, created_at
    from public.customer_invoice_attempts
    where tenant_id = ${tenantId} and invoice_id = ${invoiceId}
    order by created_at asc`;
  return rows.map((r) => ({
    id: r.id, invoiceNumber: r.invoice_number, outcome: r.outcome, xeroInvoiceId: r.xero_invoice_id,
    idempotencyKey: r.idempotency_key, requestHash: r.request_hash, httpStatus: int(r.http_status),
    errorCategory: r.error_category, errorDetail: r.error_detail, at: iso(r.created_at),
  }));
}

/** Xero's own status and amounts for an invoice → the mirror columns. */
function mirrorSet(m) {
  return {
    xero_status: m.status,
    xero_subtotal_cents: m.subtotalCents,
    xero_tax_cents: m.taxCents,
    xero_total_cents: m.totalCents,
    xero_amount_due_cents: m.amountDueCents,
    xero_amount_paid_cents: m.amountPaidCents,
    xero_amount_credited_cents: m.amountCreditedCents,
    xero_due_date: m.dueDate,
    xero_fully_paid_on: m.fullyPaidOn,
    xero_updated_at: m.updatedAt,
  };
}

/**
 * Xero has the invoice: record its id and its figures, and move the row from
 * `sending` (or `failed`, when a later check finds it after all) to `sent`.
 * Returns null when the row was not waiting for this — nothing is changed.
 */
async function markAccepted(sql, tenantId, id, { xeroInvoiceId, mirror, drift }) {
  const rows = await sql`
    update public.customer_invoices set
      ${sql(mirrorSet(mirror))},
      state            = 'sent',
      xero_invoice_id  = ${xeroInvoiceId},
      drift            = ${drift ? sql.json(drift) : null},
      failure_category = null,
      failure_detail   = null,
      sent_at          = coalesce(sent_at, now()),
      last_checked_at  = now(),
      version          = version + 1
    where tenant_id = ${tenantId} and id = ${id} and state in ('sending','failed') and seq is not null
    returning *`;
  return rows.length ? invoiceRow(rows[0]) : null;
}

/** Xero refused it and nothing exists there under this number. */
async function markFailed(sql, tenantId, id, { category, detail }) {
  const rows = await sql`
    update public.customer_invoices set
      state            = 'failed',
      failure_category = ${category},
      failure_detail   = ${detail == null ? null : String(detail).slice(0, 1000)},
      version          = version + 1
    where tenant_id = ${tenantId} and id = ${id} and state in ('sending','failed')
    returning *`;
  return rows.length ? invoiceRow(rows[0]) : null;
}

/** No answer from Xero: the row STAYS `sending` (it may exist there) and
 *  carries why, so the next step is a look-up, never a blind re-send. */
async function noteUnknown(sql, tenantId, id, { category, detail }) {
  const rows = await sql`
    update public.customer_invoices set
      failure_category = ${category},
      failure_detail   = ${detail == null ? null : String(detail).slice(0, 1000)},
      version          = version + 1
    where tenant_id = ${tenantId} and id = ${id} and state = 'sending'
    returning *`;
  return rows.length ? invoiceRow(rows[0]) : null;
}

/**
 * Put a stage that never reached Xero back to `planned` so it can be edited
 * and sent again: its number is released and the frozen snapshot cleared.
 * ONLY for a row with no Xero invoice — the caller has just confirmed Xero
 * holds nothing under the number.
 */
async function resetToPlanned(sql, tenantId, id, { actor }) {
  return sql.begin(async (tx) => {
    const rows = await tx`
      update public.customer_invoices set
        state = 'planned', seq = null, invoice_number = null,
        gross_cents = null, retention_cents = null, net_cents = null,
        invoice_date = null, due_date = null, reference = null, content_hash = null, sent_footer = null,
        external_tenant_id = null, xero_contact_id = null, xero_contact_name = null,
        failure_category = null, failure_detail = null,
        sent_by_legacy_id = null, sent_by_name = null,
        version = version + 1
      where tenant_id = ${tenantId} and id = ${id}
        and state in ('sending','failed') and xero_invoice_id is null
      returning *`;
    if (!rows.length) {
      const cur = await tx`select state from public.customer_invoices where tenant_id = ${tenantId} and id = ${id}`;
      throw new StoreConflict(cur.length ? 'not_resettable' : 'not_found');
    }
    const row = invoiceRow(rows[0]);
    await insertEvent(tx, tenantId, { invoiceId: row.id, jobId: row.jobId, event: 'edited', actor, detail: { reset: true } });
    return row;
  });
}

/**
 * The number this stage was given is taken in Xero by something else. Burn
 * it: the row is cancelled KEEPING its number (never reused), and a new
 * planned copy of its content is added so the next send takes the next one.
 */
async function raiseAgain(sql, tenantId, id, { actor }) {
  return sql.begin(async (tx) => {
    const old = await tx`
      update public.customer_invoices set state = 'cancelled', version = version + 1
      where tenant_id = ${tenantId} and id = ${id} and state = 'failed' and xero_invoice_id is null
      returning *`;
    if (!old.length) {
      const cur = await tx`select state from public.customer_invoices where tenant_id = ${tenantId} and id = ${id}`;
      throw new StoreConflict(cur.length ? 'not_raisable' : 'not_found');
    }
    const o = old[0];
    const ins = await tx`
      insert into public.customer_invoices
        (tenant_id, job_legacy_id, kind, sort_order, title, basis, percent_bp, amount_cents,
         extra_lines, items, planned_date, note, created_by_legacy_id, created_by_name)
      values (${tenantId}, ${o.job_legacy_id}, ${o.kind}, ${o.sort_order}, ${o.title}, ${o.basis}, ${o.percent_bp},
              ${o.amount_cents}, ${tx.json(extraLinesOf(o.extra_lines))}, ${tx.json(itemsJson(o.items))}, ${o.planned_date}, ${o.note},
              ${(actor && actor.id) || null}, ${(actor && actor.name) || null})
      returning *`;
    const fresh = invoiceRow(ins[0]);
    await insertEvent(tx, tenantId, { invoiceId: o.id, jobId: o.job_legacy_id, event: 'raised_again', actor, detail: { burnedNumber: o.invoice_number, newId: fresh.id } });
    await insertEvent(tx, tenantId, { invoiceId: fresh.id, jobId: o.job_legacy_id, event: 'created', actor, detail: { raisedFrom: o.id, burnedNumber: o.invoice_number } });
    return fresh;
  });
}

// ── the business's invoicing habits (#1162) ─────────────────────────────────

function usualChargesOf(v) {
  const raw = json(v, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && typeof c.name === 'string' && c.name.trim() && Number.isInteger(Number(c.unitCents)))
    .map((c) => ({
      id: String(c.id || ''),
      name: c.name,
      unit: typeof c.unit === 'string' && c.unit ? c.unit : null,
      unitCents: Number(c.unitCents),
      kind: c.kind === 'labour' ? 'labour' : 'other',
    }));
}

function prefsRow(r) {
  if (!r) return null;
  return {
    materialsMarkupBp: int(r.materials_markup_bp),
    labourRoundMinutes: int(r.labour_round_minutes) || 0,
    usualCharges: usualChargesOf(r.usual_charges),
    version: int(r.version),
    updatedBy: r.updated_by_name,
    updatedAt: iso(r.updated_at),
  };
}

/** The tenant's invoicing habits, or null until they are first saved. */
async function getPrefs(sql, tenantId) {
  const rows = await sql`select * from public.customer_invoice_prefs where tenant_id = ${tenantId}`;
  return rows.length ? prefsRow(rows[0]) : null;
}

/** Create or replace the habits (compare-and-swap; null version = first save). */
async function savePrefs(sql, tenantId, v, { expectedVersion, actor }) {
  return sql.begin(async (tx) => {
    const cur = await tx`
      select version from public.customer_invoice_prefs where tenant_id = ${tenantId} for update`;
    let row;
    if (!cur.length) {
      if (expectedVersion != null) throw new StoreConflict('version');
      const ins = await tx`
        insert into public.customer_invoice_prefs
          (tenant_id, materials_markup_bp, labour_round_minutes, usual_charges, updated_by_legacy_id, updated_by_name)
        values (${tenantId}, ${v.materialsMarkupBp == null ? null : v.materialsMarkupBp}, ${v.labourRoundMinutes || 0},
                ${tx.json(v.usualCharges || [])}, ${(actor && actor.id) || null}, ${(actor && actor.name) || null})
        returning *`;
      row = ins[0];
    } else {
      if (Number(cur[0].version) !== Number(expectedVersion)) throw new StoreConflict('version');
      const upd = await tx`
        update public.customer_invoice_prefs set
          materials_markup_bp  = ${v.materialsMarkupBp == null ? null : v.materialsMarkupBp},
          labour_round_minutes = ${v.labourRoundMinutes || 0},
          usual_charges        = ${tx.json(v.usualCharges || [])},
          version              = version + 1,
          updated_by_legacy_id = ${(actor && actor.id) || null},
          updated_by_name      = ${(actor && actor.name) || null}
        where tenant_id = ${tenantId}
        returning *`;
      row = upd[0];
    }
    await insertEvent(tx, tenantId, { event: 'prefs_updated', actor, detail: {} });
    return prefsRow(row);
  });
}

// ── variations (#1163) ──────────────────────────────────────────────────────

function variationRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    jobId: r.job_legacy_id,
    seq: int(r.seq),
    title: r.title,
    detail: r.detail,
    requestedBy: r.requested_by,
    requestedOn: dateOnly(r.requested_on),
    quotedCents: cents(r.quoted_cents),
    status: r.status,
    approvedCents: cents(r.approved_cents),
    approvalRef: r.approval_ref,
    decidedOn: dateOnly(r.decided_on),
    decidedBy: r.decided_by_name,
    version: int(r.version),
    createdBy: r.created_by_name,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

/** A job's variations, V1 first. Removed ones are left out. */
async function listVariations(sql, tenantId, jobLegacyId) {
  const rows = await sql`
    select * from public.customer_invoice_variations
    where tenant_id = ${tenantId} and job_legacy_id = ${jobLegacyId} and removed_at is null
    order by seq asc`;
  return rows.map(variationRow);
}

async function getVariation(sql, tenantId, id) {
  const rows = await sql`
    select * from public.customer_invoice_variations
    where tenant_id = ${tenantId} and id = ${id} and removed_at is null`;
  return rows.length ? variationRow(rows[0]) : null;
}

/** Add a proposed variation; it takes the job's next number. */
async function createVariation(sql, tenantId, jobLegacyId, v, actor) {
  return sql.begin(async (tx) => {
    // One at a time per job, so two adds can never take the same number.
    await tx`select pg_advisory_xact_lock(hashtextextended(${`customer-invoice-variation:${tenantId}:${jobLegacyId}`}, 0))`;
    const next = await tx`
      select coalesce(max(seq), 0) + 1 as n
      from public.customer_invoice_variations
      where tenant_id = ${tenantId} and job_legacy_id = ${jobLegacyId}`;
    const rows = await tx`
      insert into public.customer_invoice_variations
        (tenant_id, job_legacy_id, seq, title, detail, requested_by, requested_on, quoted_cents,
         created_by_legacy_id, created_by_name)
      values (${tenantId}, ${jobLegacyId}, ${Number(next[0].n)}, ${v.title}, ${v.detail || null},
              ${v.requestedBy || null}, ${v.requestedOn || null}, ${v.quotedCents == null ? null : v.quotedCents},
              ${(actor && actor.id) || null}, ${(actor && actor.name) || null})
      returning *`;
    const row = variationRow(rows[0]);
    await insertEvent(tx, tenantId, { jobId: jobLegacyId, event: 'variation_added', actor, detail: { variationId: row.id, seq: row.seq } });
    return row;
  });
}

async function variationConflict(tx, tenantId, id) {
  const cur = await tx`
    select id from public.customer_invoice_variations
    where tenant_id = ${tenantId} and id = ${id} and removed_at is null`;
  return cur.length ? 'version' : 'not_found';
}

/** Replace a variation's wording and quote (compare-and-swap). */
async function updateVariation(sql, tenantId, id, v, { expectedVersion, actor, guard, jobId }) {
  return sql.begin(async (tx) => {
    if (guard) { await lockJobLines(tx, tenantId, jobId); await guard(tx); }
    const rows = await tx`
      update public.customer_invoice_variations set
        title        = ${v.title},
        detail       = ${v.detail || null},
        requested_by = ${v.requestedBy || null},
        requested_on = ${v.requestedOn || null},
        quoted_cents = ${v.quotedCents == null ? null : v.quotedCents},
        version      = version + 1
      where tenant_id = ${tenantId} and id = ${id} and removed_at is null and version = ${expectedVersion}
      returning *`;
    if (!rows.length) throw new StoreConflict(await variationConflict(tx, tenantId, id));
    const row = variationRow(rows[0]);
    await insertEvent(tx, tenantId, { jobId: row.jobId, event: 'variation_edited', actor, detail: { variationId: row.id, seq: row.seq } });
    return row;
  });
}

/** Approve, decline or re-open a variation (compare-and-swap). */
async function decideVariation(sql, tenantId, id, d, { expectedVersion, actor, guard, jobId }) {
  return sql.begin(async (tx) => {
    if (guard) { await lockJobLines(tx, tenantId, jobId); await guard(tx); }
    const decided = d.status !== 'proposed';
    const rows = await tx`
      update public.customer_invoice_variations set
        status               = ${d.status},
        approved_cents       = ${d.status === 'approved' ? d.approvedCents : null},
        approval_ref         = ${decided ? d.approvalRef || null : null},
        decided_on           = ${decided ? d.decidedOn || null : null},
        decided_by_legacy_id = ${decided ? (actor && actor.id) || null : null},
        decided_by_name      = ${decided ? (actor && actor.name) || null : null},
        version              = version + 1
      where tenant_id = ${tenantId} and id = ${id} and removed_at is null and version = ${expectedVersion}
      returning *`;
    if (!rows.length) throw new StoreConflict(await variationConflict(tx, tenantId, id));
    const row = variationRow(rows[0]);
    const event = d.status === 'approved' ? 'variation_approved' : d.status === 'declined' ? 'variation_declined' : 'variation_reopened';
    await insertEvent(tx, tenantId, { jobId: row.jobId, event, actor, detail: { variationId: row.id, seq: row.seq } });
    return row;
  });
}

/** Take a variation off the list. Its row stays, so its number is never reused. */
async function removeVariation(sql, tenantId, id, { expectedVersion, actor, guard, jobId }) {
  return sql.begin(async (tx) => {
    if (guard) { await lockJobLines(tx, tenantId, jobId); await guard(tx); }
    const rows = await tx`
      update public.customer_invoice_variations set removed_at = now(), version = version + 1
      where tenant_id = ${tenantId} and id = ${id} and removed_at is null and version = ${expectedVersion}
      returning *`;
    if (!rows.length) throw new StoreConflict(await variationConflict(tx, tenantId, id));
    const row = variationRow(rows[0]);
    await insertEvent(tx, tenantId, { jobId: row.jobId, event: 'variation_removed', actor, detail: { variationId: row.id, seq: row.seq, title: row.title } });
    return row;
  });
}

/** Add one extra line to a PLANNED stage (compare-and-swap on its version). */
async function appendExtraLine(sql, tenantId, id, line, { expectedVersion, actor, guard, jobId }) {
  return sql.begin(async (tx) => {
    if (guard) { await lockJobLines(tx, tenantId, jobId); await guard(tx); }
    const cur = await tx`
      select * from public.customer_invoices where tenant_id = ${tenantId} and id = ${id} for update`;
    if (!cur.length) throw new StoreConflict('not_found');
    if (cur[0].state !== 'planned') throw new StoreConflict('not_planned');
    if (Number(cur[0].version) !== Number(expectedVersion)) throw new StoreConflict('version');
    const lines = extraLinesOf(cur[0].extra_lines).concat([line]);
    const rows = await tx`
      update public.customer_invoices set extra_lines = ${tx.json(lines)}, version = version + 1
      where tenant_id = ${tenantId} and id = ${id}
      returning *`;
    const row = invoiceRow(rows[0]);
    await insertEvent(tx, tenantId, { invoiceId: row.id, jobId: row.jobId, event: 'edited', actor, detail: { addedLine: true } });
    return row;
  });
}

// ── paid status: keeping the Xero mirror current (#1151) ────────────────────

const POLL_BATCH_LIMIT = 500;

/**
 * Sent invoices in ONE Xero organisation that are worth asking Xero about:
 *   * anything not yet settled (draft, submitted, approved), every time;
 *   * a PAID invoice once a day for 60 days after it was paid in full —
 *     a payment can be removed or a credit note reversed;
 *   * never a VOIDED or DELETED one (those are final in Xero).
 * Oldest-checked first, so a large backlog still makes progress.
 */
async function listForStatusCheck(sql, tenantId, externalTenantId, { limit = POLL_BATCH_LIMIT } = {}) {
  if (!externalTenantId) return [];
  const rows = await sql`
    select * from public.customer_invoices
    where tenant_id = ${tenantId}
      and external_tenant_id = ${externalTenantId}
      and state = 'sent'
      and xero_invoice_id is not null
      and (
        xero_status is null
        or xero_status in ('DRAFT','SUBMITTED','AUTHORISED')
        or (xero_status = 'PAID'
            and (last_checked_at is null or last_checked_at < now() - interval '1 day')
            and (xero_fully_paid_on is null or xero_fully_paid_on > current_date - 60))
      )
    order by last_checked_at asc nulls first
    limit ${limit}`;
  return rows.map(invoiceRow);
}

/** Every sent invoice on one job in the connected organisation — for "Check
 *  Xero now" (includes paid and dead ones: the office asked, so ask). */
async function listJobSent(sql, tenantId, jobLegacyId, externalTenantId) {
  if (!externalTenantId) return [];
  const rows = await sql`
    select * from public.customer_invoices
    where tenant_id = ${tenantId} and job_legacy_id = ${jobLegacyId}
      and external_tenant_id = ${externalTenantId}
      and state = 'sent' and xero_invoice_id is not null
    order by seq asc`;
  return rows.map(invoiceRow);
}

/**
 * Write what Xero says about a SENT invoice: its status, amounts and dates,
 * and whether it still matches what BuhlOS sent. Xero's figures win (ADR rule
 * 6). When `event` is given (something moved) it is recorded in the same
 * transaction. Returns null when the row is no longer a sent invoice.
 */
async function applyMirror(sql, tenantId, id, { mirror, drift, event }) {
  return sql.begin(async (tx) => {
    const rows = await tx`
      update public.customer_invoices set
        ${tx(mirrorSet(mirror))},
        drift           = ${drift ? tx.json(drift) : null},
        last_checked_at = now(),
        version         = version + 1
      where tenant_id = ${tenantId} and id = ${id} and state = 'sent'
      returning *`;
    if (!rows.length) return null;
    const row = invoiceRow(rows[0]);
    if (event) {
      await insertEvent(tx, tenantId, { invoiceId: row.id, jobId: row.jobId, event: 'status_changed', detail: event });
    }
    return row;
  });
}

/** Xero was asked and nothing moved: only note that it was checked. */
async function touchChecked(sql, tenantId, ids) {
  if (!Array.isArray(ids) || !ids.length) return;
  await sql`
    update public.customer_invoices set last_checked_at = now()
    where tenant_id = ${tenantId} and id in ${sql(ids)} and state = 'sent'`;
}

/**
 * A SENT stage whose invoice Xero shows as DELETED or VOIDED is raised again:
 * a new planned copy is added (it will take the next number), and the old row
 * STAYS as history, marked with what replaced it so it can't be raised twice.
 */
async function raiseAgainSent(sql, tenantId, id, { actor }) {
  return sql.begin(async (tx) => {
    const cur = await tx`
      select * from public.customer_invoices
      where tenant_id = ${tenantId} and id = ${id}
      for update`;
    if (!cur.length) throw new StoreConflict('not_found');
    const o = cur[0];
    if (o.state !== 'sent' || !(o.xero_status === 'DELETED' || o.xero_status === 'VOIDED') || o.replaced_by_id) {
      throw new StoreConflict('not_raisable');
    }
    const ins = await tx`
      insert into public.customer_invoices
        (tenant_id, job_legacy_id, kind, sort_order, title, basis, percent_bp, amount_cents,
         extra_lines, items, planned_date, note, created_by_legacy_id, created_by_name)
      values (${tenantId}, ${o.job_legacy_id}, ${o.kind}, ${o.sort_order}, ${o.title}, ${o.basis}, ${o.percent_bp},
              ${o.amount_cents}, ${tx.json(extraLinesOf(o.extra_lines))}, ${tx.json(itemsJson(o.items))}, ${o.planned_date}, ${o.note},
              ${(actor && actor.id) || null}, ${(actor && actor.name) || null})
      returning *`;
    const fresh = invoiceRow(ins[0]);
    await tx`
      update public.customer_invoices set replaced_by_id = ${fresh.id}, version = version + 1
      where tenant_id = ${tenantId} and id = ${id}`;
    await insertEvent(tx, tenantId, { invoiceId: o.id, jobId: o.job_legacy_id, event: 'raised_again', actor, detail: { xeroStatus: o.xero_status, newId: fresh.id } });
    await insertEvent(tx, tenantId, { invoiceId: fresh.id, jobId: o.job_legacy_id, event: 'created', actor, detail: { raisedFrom: o.id, afterXeroStatus: o.xero_status } });
    return fresh;
  });
}

module.exports = {
  TENANT_SLUG,
  StoreConflict,
  listForStatusCheck,
  listJobSent,
  applyMirror,
  touchChecked,
  raiseAgainSent,
  peekNextSeq,
  beginSend,
  insertAttempt,
  listAttempts,
  markAccepted,
  markFailed,
  noteUnknown,
  resetToPlanned,
  raiseAgain,
  resolveTenant,
  getPrefs,
  savePrefs,
  listVariations,
  getVariation,
  createVariation,
  updateVariation,
  decideVariation,
  removeVariation,
  appendExtraLine,
  profileRow,
  invoiceRow,
  settingsRow,
  insertEvent,
  listJobEvents,
  getProfile,
  saveProfile,
  latestContactAmongJobs,
  getSettings,
  saveSettings,
  settingsComplete,
  listJobInvoices,
  getInvoice,
  createStage,
  updateStage,
  removeStage,
};
