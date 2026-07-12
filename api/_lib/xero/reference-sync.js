// Xero payroll reference-data sync (#610) — the ONE read-only reference
// layer every mapping/validation child consumes (#248 employees, #611
// earnings rates, #254 tracking categories, #249 pre-flight).
//
// Boundary (payroll-boundary ADR clause 4): the cache is for MAPPING /
// VALIDATION ONLY and is NEVER authoritative — Xero stays the source of
// truth. Everything here is a GET through the shared client (./client.js);
// no write call to Xero exists in this module or anywhere beneath it.
//
// Sync groups (one Xero fetch each, independently failable):
//   employees           GET {PAYROLL_AU_BASE}/Employees?page=N   (paged, 100/page)
//   calendars           GET {PAYROLL_AU_BASE}/PayrollCalendars
//   pay_items           GET {PAYROLL_AU_BASE}/PayItems           (earnings rates,
//                       leave types, deduction types, reimbursement types)
//   tracking_categories GET {ACCOUNTING_BASE}/TrackingCategories (for #254)
//
// Each group's refresh is a WHOLESALE REPLACE of its kinds for this Xero
// organisation, in one transaction — a half-fetched group never half-lands.
// Every fetch writes an append-only xero_reference_syncs row (ok/failed,
// count, error category, correlation id) — the record #251's sync-health
// surface reads. A failed fetch keeps the previous cache and logs loudly;
// it can never leave an empty cache that reads as "the org has no employees".
//
// Data minimisation (ADR clause 5): mappers below are explicit ALLOW-LISTS.
// No TFN, bank detail, date of birth, address, phone or pay amount is ever
// stored — only what mapping needs (ids, names, status, calendar linkage,
// email for #248's suggestion ranking, rate/leave classification).

const { getDb } = require('../supabase-db');
const store = require('./token-store');
const { xeroFetch } = require('./client');
const { XeroError } = require('./errors');
const { PAYROLL_AU_BASE, ACCOUNTING_BASE } = require('./config');

const SYNC_GROUPS = ['employees', 'calendars', 'pay_items', 'tracking_categories'];

const GROUP_KINDS = {
  employees: ['employee'],
  calendars: ['payroll_calendar'],
  pay_items: ['earnings_rate', 'leave_type', 'deduction_type', 'reimbursement_type'],
  tracking_categories: ['tracking_category'],
};

// A cache older than this renders as STALE (visibly, on the reference panel).
// Reference data changes rarely; a week keeps honest pressure without noise.
const STALE_AFTER_DAYS = 7;

const EMPLOYEE_PAGE_SIZE = 100;
const MAX_EMPLOYEE_PAGES = 50; // 5,000 employees — a runaway-loop backstop, not a real limit

// ── pure mappers (exported for tests) — explicit allow-lists ────────────────

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Payroll AU employee list row → cache item. NO DoB/address/phone/TFN. */
function mapEmployee(e) {
  const id = str(e && e.EmployeeID);
  if (!id) return null;
  const firstName = str(e.FirstName) || '';
  const lastName = str(e.LastName) || '';
  const status = str(e.Status) || 'ACTIVE';
  return {
    kind: 'employee',
    xeroId: id,
    name: `${firstName} ${lastName}`.trim() || '(unnamed employee)',
    active: status !== 'TERMINATED',
    payload: {
      firstName,
      lastName,
      status,
      email: str(e.Email),
      payrollCalendarID: str(e.PayrollCalendarID),
      updatedDateUTC: str(e.UpdatedDateUTC),
    },
  };
}

function mapCalendar(c) {
  const id = str(c && c.PayrollCalendarID);
  if (!id) return null;
  return {
    kind: 'payroll_calendar',
    xeroId: id,
    name: str(c.Name) || '(unnamed calendar)',
    active: true,
    payload: {
      calendarType: str(c.CalendarType),
      startDate: str(c.StartDate),
      paymentDate: str(c.PaymentDate),
    },
  };
}

function mapPayItem(kind, idField, item) {
  const id = str(item && item[idField]);
  if (!id) return null;
  // Pay items carry CurrentRecord: false once superseded/deleted in Xero —
  // exactly the inactive-rate detection #611 blocks exports on.
  const active = item.CurrentRecord !== false;
  return {
    kind,
    xeroId: id,
    name: str(item.Name) || `(unnamed ${kind.replace('_', ' ')})`,
    active,
    payload: {
      ...(kind === 'earnings_rate'
        ? {
            earningsType: str(item.EarningsType),
            rateType: str(item.RateType),
            accountCode: str(item.AccountCode),
          }
        : {}),
      ...(kind === 'leave_type' ? { typeOfUnits: str(item.TypeOfUnits) } : {}),
      currentRecord: active,
    },
  };
}

/** PayItems response object → items across the four pay-item kinds. */
function mapPayItems(payItems) {
  const p = payItems || {};
  const out = [];
  for (const e of Array.isArray(p.EarningsRates) ? p.EarningsRates : []) {
    const m = mapPayItem('earnings_rate', 'EarningsRateID', e);
    if (m) out.push(m);
  }
  for (const l of Array.isArray(p.LeaveTypes) ? p.LeaveTypes : []) {
    const m = mapPayItem('leave_type', 'LeaveTypeID', l);
    if (m) out.push(m);
  }
  for (const d of Array.isArray(p.DeductionTypes) ? p.DeductionTypes : []) {
    const m = mapPayItem('deduction_type', 'DeductionTypeID', d);
    if (m) out.push(m);
  }
  for (const r of Array.isArray(p.ReimbursementTypes) ? p.ReimbursementTypes : []) {
    const m = mapPayItem('reimbursement_type', 'ReimbursementTypeID', r);
    if (m) out.push(m);
  }
  return out;
}

function mapTrackingCategory(t) {
  const id = str(t && t.TrackingCategoryID);
  if (!id) return null;
  return {
    kind: 'tracking_category',
    xeroId: id,
    name: str(t.Name) || '(unnamed category)',
    active: str(t.Status) !== 'ARCHIVED',
    payload: {
      status: str(t.Status),
      options: (Array.isArray(t.Options) ? t.Options : [])
        .map((o) => ({ id: str(o.TrackingOptionID), name: str(o.Name), status: str(o.Status) }))
        .filter((o) => o.id),
    },
  };
}

// ── fetchers (via the shared client — never raw fetch) ──────────────────────

async function fetchEmployees(deps) {
  const items = [];
  for (let page = 1; page <= MAX_EMPLOYEE_PAGES; page += 1) {
    const { data } = await xeroFetch(`${PAYROLL_AU_BASE}/Employees?page=${page}`, { deps });
    const rows = data && Array.isArray(data.Employees) ? data.Employees : [];
    for (const r of rows) {
      const m = mapEmployee(r);
      if (m) items.push(m);
    }
    if (rows.length < EMPLOYEE_PAGE_SIZE) break;
  }
  return items;
}

async function fetchCalendars(deps) {
  const { data } = await xeroFetch(`${PAYROLL_AU_BASE}/PayrollCalendars`, { deps });
  const rows = data && Array.isArray(data.PayrollCalendars) ? data.PayrollCalendars : [];
  return rows.map(mapCalendar).filter(Boolean);
}

async function fetchPayItems(deps) {
  const { data } = await xeroFetch(`${PAYROLL_AU_BASE}/PayItems`, { deps });
  return mapPayItems(data && data.PayItems);
}

async function fetchTrackingCategories(deps) {
  const { data } = await xeroFetch(`${ACCOUNTING_BASE}/TrackingCategories`, { deps });
  const rows = data && Array.isArray(data.TrackingCategories) ? data.TrackingCategories : [];
  return rows.map(mapTrackingCategory).filter(Boolean);
}

const FETCHERS = {
  employees: fetchEmployees,
  calendars: fetchCalendars,
  pay_items: fetchPayItems,
  tracking_categories: fetchTrackingCategories,
};

// ── storage ──────────────────────────────────────────────────────────────────

/** Wholesale-replace one group's kinds for this org, in one transaction. */
async function replaceGroupItems(sql, { tenantId, externalTenantId, group, items }) {
  const kinds = GROUP_KINDS[group];
  await sql.begin(async (tx) => {
    await tx`
      delete from public.xero_reference_items
      where tenant_id = ${tenantId}
        and external_tenant_id = ${externalTenantId}
        and kind in ${tx(kinds)}
    `;
    for (const item of items) {
      // ::jsonb cast — a bare stringified parameter lands as a jsonb STRING
      // scalar (double-encoded), proven on the first live sync. The cast
      // parses it into a real object so consumers read payload.email etc.
      await tx`
        insert into public.xero_reference_items (
          tenant_id, external_tenant_id, kind, xero_id, name, active, payload
        ) values (
          ${tenantId}, ${externalTenantId}, ${item.kind}, ${item.xeroId},
          ${item.name}, ${item.active}, ${JSON.stringify(item.payload)}::jsonb
        )
      `;
    }
  });
}

async function appendSyncLog(sql, { tenantId, externalTenantId, group, status, itemCount, errorCategory, correlationId, actor }) {
  await sql`
    insert into public.xero_reference_syncs (
      tenant_id, external_tenant_id, sync_group, status, item_count,
      error_category, correlation_id, actor_legacy_id, actor_name
    ) values (
      ${tenantId}, ${externalTenantId}, ${group}, ${status}, ${itemCount == null ? null : itemCount},
      ${errorCategory || null}, ${correlationId || null},
      ${actor ? String(actor.id) : null}, ${actor ? String(actor.name || actor.username || '') : null}
    )
  `;
}

// ── the service ──────────────────────────────────────────────────────────────

/**
 * Refresh reference data from Xero. Groups run independently: one failing
 * group logs its failure and the others still land — the return value names
 * every group's outcome (never a whole-batch false success).
 *
 * @param {{ groups?: string[], actor?: object, deps?: object }} [opts]
 *   deps: { sql, store, env, fetchImpl } — injectable for tests.
 * @returns {Promise<Array<{ group: string, status: 'ok'|'failed', itemCount?: number, errorCategory?: string }>>}
 */
async function syncReferenceData(opts = {}) {
  const deps = opts.deps || {};
  const s = deps.store || store;
  const sql = deps.sql || getDb({ mode: 'write' });
  const groups = (opts.groups && opts.groups.length ? opts.groups : SYNC_GROUPS)
    .filter((g) => SYNC_GROUPS.includes(g));

  const row = await s.getConnection({ sql: deps.sql });
  if (!row) throw new XeroError('not_connected');
  if (row.status === 'pending_selection') throw new XeroError('pending_selection');
  if (!row.external_tenant_id) throw new XeroError('pending_selection');
  const tenantId = row.tenant_id;
  const externalTenantId = row.external_tenant_id;

  const results = [];
  for (const group of groups) {
    try {
      const items = await FETCHERS[group]({ ...deps, sql: deps.sql });
      await replaceGroupItems(sql, { tenantId, externalTenantId, group, items });
      await appendSyncLog(sql, {
        tenantId, externalTenantId, group,
        status: 'ok', itemCount: items.length, actor: opts.actor,
      });
      results.push({ group, status: 'ok', itemCount: items.length });
    } catch (err) {
      const errorCategory = err instanceof XeroError ? err.category : 'unexpected';
      const correlationId = err instanceof XeroError ? err.correlationId : null;
      // The failure must be a durable record — but a broken log write can't
      // hide the failure either (the result row still reports it).
      await appendSyncLog(sql, {
        tenantId, externalTenantId, group,
        status: 'failed', errorCategory, correlationId, actor: opts.actor,
      }).catch(() => {});
      results.push({ group, status: 'failed', errorCategory });
    }
  }
  return results;
}

/**
 * Cache summary for the reference panel: per-group counts (by kind), the
 * latest sync outcome, and honest staleness.
 */
async function getReferenceSummary(opts = {}) {
  const deps = opts.deps || {};
  const s = deps.store || store;
  const sql = deps.sql || getDb({ mode: 'read' });

  const row = await s.getConnection({ sql: deps.sql });
  if (!row) throw new XeroError('not_connected');
  const tenantId = row.tenant_id;
  const externalTenantId = row.external_tenant_id;

  const counts = await sql`
    select kind, count(*)::int as count, min(synced_at) as oldest_synced_at
    from public.xero_reference_items
    where tenant_id = ${tenantId} and external_tenant_id = ${externalTenantId}
    group by kind
  `;
  const lastSyncs = await sql`
    select distinct on (sync_group)
      sync_group, status, item_count, error_category, correlation_id, created_at
    from public.xero_reference_syncs
    where tenant_id = ${tenantId} and external_tenant_id = ${externalTenantId}
    order by sync_group, created_at desc
  `;

  const countByKind = new Map(counts.map((c) => [c.kind, c]));
  const lastByGroup = new Map(lastSyncs.map((l) => [l.sync_group, l]));
  const staleCutoff = Date.now() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;

  const groups = SYNC_GROUPS.map((group) => {
    const last = lastByGroup.get(group) || null;
    const kinds = GROUP_KINDS[group].map((kind) => ({
      kind,
      count: countByKind.has(kind) ? countByKind.get(kind).count : 0,
    }));
    const lastOkAt = last && last.status === 'ok' ? new Date(last.created_at).getTime() : null;
    return {
      group,
      kinds,
      lastSync: last
        ? {
            at: last.created_at,
            status: last.status,
            itemCount: last.item_count,
            errorCategory: last.error_category,
            correlationId: last.correlation_id,
          }
        : null,
      // never synced OR last good sync is old → stale (visibly, P7)
      stale: lastOkAt === null || lastOkAt < staleCutoff,
    };
  });

  return { staleAfterDays: STALE_AFTER_DAYS, groups };
}

/** Safe item list for one kind (payloads are allow-listed at write time). */
async function getReferenceItems(kind, opts = {}) {
  const deps = opts.deps || {};
  const s = deps.store || store;
  const sql = deps.sql || getDb({ mode: 'read' });
  const row = await s.getConnection({ sql: deps.sql });
  if (!row) throw new XeroError('not_connected');
  const rows = await sql`
    select xero_id, name, active, payload, synced_at
    from public.xero_reference_items
    where tenant_id = ${row.tenant_id}
      and external_tenant_id = ${row.external_tenant_id}
      and kind = ${kind}
    order by name
  `;
  return rows.map((r) => ({
    xeroId: r.xero_id,
    name: r.name,
    active: r.active,
    payload: normalisePayload(r.payload),
    syncedAt: r.synced_at,
  }));
}

/** Rows written before the ::jsonb cast fix hold a double-encoded string —
 *  normalise on read so consumers always get the object. Self-heals fully on
 *  the next refresh (wholesale replace). */
function normalisePayload(payload) {
  if (typeof payload !== 'string') return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

module.exports = {
  SYNC_GROUPS,
  GROUP_KINDS,
  STALE_AFTER_DAYS,
  mapEmployee,
  mapCalendar,
  mapPayItems,
  mapTrackingCategory,
  syncReferenceData,
  getReferenceSummary,
  getReferenceItems,
};
