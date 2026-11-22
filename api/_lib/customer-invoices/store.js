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
    .map((l) => ({ description: l.description, amountCents: cents(l.amountCents) }))
    .filter((l) => l.amountCents != null);
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
    retentionBp: int(r.retention_bp),
    plannedDate: dateOnly(r.planned_date),
    note: r.note,
    grossCents: cents(r.gross_cents),
    retentionCents: cents(r.retention_cents),
    netCents: cents(r.net_cents),
    invoiceDate: dateOnly(r.invoice_date),
    dueDate: dateOnly(r.due_date),
    reference: r.reference,
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
           retention_bp, updated_by_legacy_id, updated_by_name)
        values (${tenantId}, ${jobLegacyId},
                ${has('xeroContactId') ? patch.xeroContactId : null},
                ${has('xeroContactName') ? patch.xeroContactName : null},
                ${has('externalTenantId') ? patch.externalTenantId : null},
                ${has('retentionBp') ? patch.retentionBp : 0},
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

/** Add a planned stage at the end of the job's list. */
async function createStage(sql, tenantId, jobLegacyId, s, actor) {
  return sql.begin(async (tx) => {
    const next = await tx`
      select coalesce(max(sort_order), 0) + 1 as n
      from public.customer_invoices
      where tenant_id = ${tenantId} and job_legacy_id = ${jobLegacyId}`;
    const rows = await tx`
      insert into public.customer_invoices
        (tenant_id, job_legacy_id, kind, sort_order, title, basis, percent_bp, amount_cents,
         extra_lines, retention_bp, planned_date, note, created_by_legacy_id, created_by_name)
      values (${tenantId}, ${jobLegacyId}, ${s.kind || 'stage'}, ${Number(next[0].n)}, ${s.title}, ${s.basis},
              ${s.basis === 'percent' ? s.percentBp : null}, ${s.basis === 'amount' ? s.amountCents : null},
              ${tx.json(s.extraLines || [])}, ${s.retentionBp == null ? null : s.retentionBp},
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

/** Replace a PLANNED stage's content (compare-and-swap on version). */
async function updateStage(sql, tenantId, id, s, { expectedVersion, actor }) {
  return sql.begin(async (tx) => {
    const rows = await tx`
      update public.customer_invoices set
        title        = ${s.title},
        basis        = ${s.basis},
        percent_bp   = ${s.basis === 'percent' ? s.percentBp : null},
        amount_cents = ${s.basis === 'amount' ? s.amountCents : null},
        extra_lines  = ${tx.json(s.extraLines || [])},
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

module.exports = {
  TENANT_SLUG,
  StoreConflict,
  resolveTenant,
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
