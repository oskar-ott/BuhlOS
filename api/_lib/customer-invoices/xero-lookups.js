'use strict';

// Customer stage invoices — the READS from Xero that set an invoice up
// (#1149; rules: docs/architecture/customer-invoicing-boundary-adr.md).
// Nothing here writes to Xero.
//
//   readiness      is Xero connected, to which organisation, with invoice
//                  permission? Decided from the stored connection row alone —
//                  never by calling Xero and reading a 401/403.
//   searchContacts live contact search so a person can link the job's client
//   getContact     one contact, to confirm a link before it is stored
//   salesAccounts  the organisation's active revenue accounts
//   taxRates       the organisation's active tax rates usable on sales
//
// DATA MINIMISATION (ADR rule 9): every mapper is an explicit allow-list.
// Xero answers a contact with addresses, phones, people and balances; only
// id, name and status ever leave this module. Nothing is cached — these are
// read live when a person opens a picker.

const { ACCOUNTING_BASE, xeroConfigured, hasInvoiceScopes } = require('../xero/config');
const { XeroError } = require('../xero/errors');
const tokenStore = require('../xero/token-store');
const client = require('../xero/client');

const CONTACT_PAGE_SIZE = 20;
const MAX_QUERY = 100;

/**
 * Whether an invoice could be set up against Xero right now, and if not, the
 * one thing to do about it. `state`:
 *   not_configured      Xero isn't set up in this environment
 *   disconnected        no connection
 *   connecting          authorised, organisation not chosen yet
 *   reconnect_required  the grant was revoked or expired
 *   missing_permission  connected, but without the invoice scopes → reconnect
 *   connected           usable (a degraded connection still counts: the next
 *                       call refreshes it, and a failure is shown then)
 */
async function readiness(deps = {}) {
  const env = deps.env || process.env;
  if (!xeroConfigured(env)) {
    return { state: 'not_configured', organisationName: null, externalTenantId: null };
  }
  const store = deps.store || tokenStore;
  const row = await store.getConnection({ sql: deps.sql });
  if (!row) return { state: 'disconnected', organisationName: null, externalTenantId: null };
  const base = {
    organisationName: row.external_tenant_name || null,
    externalTenantId: row.external_tenant_id || null,
  };
  if (row.status === 'pending_selection') return { state: 'connecting', ...base };
  if (row.status === 'reconnect_required') return { state: 'reconnect_required', ...base };
  if (!hasInvoiceScopes(row.granted_scopes)) return { state: 'missing_permission', ...base };
  return { state: 'connected', ...base };
}

/** Throw the typed error a caller should surface when Xero isn't usable. */
function assertReady(ready) {
  if (ready.state === 'connected') return;
  if (ready.state === 'missing_permission') {
    // XeroError keeps `detail` only inside its message; `reason` is the
    // machine-readable marker the handler turns into the response's `reason`.
    const err = new XeroError('reconnect_required', { detail: 'missing_invoice_scope' });
    err.reason = 'missing_invoice_scope';
    throw err;
  }
  if (ready.state === 'reconnect_required') throw new XeroError('reconnect_required');
  if (ready.state === 'connecting') throw new XeroError('pending_selection');
  if (ready.state === 'not_configured') throw new XeroError('not_configured');
  throw new XeroError('not_connected');
}

function fetchDeps(deps) {
  // xeroFetch's own deps: sql / store / env / fetchImpl pass straight through.
  return { sql: deps.sql, store: deps.store, env: deps.env, fetchImpl: deps.fetchImpl };
}
function xeroFetchOf(deps) {
  return deps.xeroFetch || client.xeroFetch;
}

// ── contacts ────────────────────────────────────────────────────────────────
function mapContact(c) {
  if (!c || typeof c.ContactID !== 'string' || !c.ContactID) return null;
  const name = typeof c.Name === 'string' ? c.Name.trim() : '';
  if (!name) return null;
  return { id: c.ContactID, name, status: typeof c.ContactStatus === 'string' ? c.ContactStatus : null };
}

/**
 * Search the organisation's contacts by name (Xero's `searchTerm`, which also
 * matches contact number and email). Returns at most 20 ACTIVE contacts as
 * { id, name } — nothing else Xero sent is kept.
 */
async function searchContacts(query, deps = {}) {
  const q = String(query || '').trim().slice(0, MAX_QUERY);
  if (q.length < 2) return [];
  const url = `${ACCOUNTING_BASE}/Contacts?searchTerm=${encodeURIComponent(q)}&page=1&pageSize=${CONTACT_PAGE_SIZE}`;
  const { data } = await xeroFetchOf(deps)(url, { deps: fetchDeps(deps) });
  const list = Array.isArray(data && data.Contacts) ? data.Contacts : [];
  return list
    .map(mapContact)
    .filter((c) => c && (c.status == null || c.status === 'ACTIVE'))
    .map((c) => ({ id: c.id, name: c.name }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One contact by id → { id, name, status }, or null when Xero has none. */
async function getContact(contactId, deps = {}) {
  if (!UUID.test(String(contactId || ''))) return null;
  let data;
  try {
    ({ data } = await xeroFetchOf(deps)(`${ACCOUNTING_BASE}/Contacts/${contactId}`, { deps: fetchDeps(deps) }));
  } catch (e) {
    if (e instanceof XeroError && e.category === 'not_found') return null;
    throw e;
  }
  const list = Array.isArray(data && data.Contacts) ? data.Contacts : [];
  return list.length ? mapContact(list[0]) : null;
}

// ── chart of accounts + tax rates ───────────────────────────────────────────
/**
 * The organisation's ACTIVE revenue accounts that carry a code (an account
 * with no code cannot be put on an invoice line). The whole chart is one GET;
 * it is filtered here rather than with a `where` clause so a filter-syntax
 * change at Xero can never empty the list silently.
 */
async function salesAccounts(deps = {}) {
  const { data } = await xeroFetchOf(deps)(`${ACCOUNTING_BASE}/Accounts`, { deps: fetchDeps(deps) });
  const list = Array.isArray(data && data.Accounts) ? data.Accounts : [];
  return list
    .filter((a) => a && a.Class === 'REVENUE' && a.Status === 'ACTIVE' && typeof a.Code === 'string' && a.Code.trim())
    .map((a) => ({
      code: a.Code.trim(),
      name: typeof a.Name === 'string' ? a.Name : a.Code.trim(),
      taxType: typeof a.TaxType === 'string' ? a.TaxType : null,
    }))
    .sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
}

/** Xero sends a rate as a decimal percentage ("10.0000") → basis points, or null. */
function rateToBp(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100);
}

/** The organisation's ACTIVE tax rates that may be used on a sales line. */
async function taxRates(deps = {}) {
  const { data } = await xeroFetchOf(deps)(`${ACCOUNTING_BASE}/TaxRates`, { deps: fetchDeps(deps) });
  const list = Array.isArray(data && data.TaxRates) ? data.TaxRates : [];
  return list
    .filter((t) => t && t.Status === 'ACTIVE' && t.CanApplyToRevenue !== false && typeof t.TaxType === 'string' && t.TaxType)
    .map((t) => ({
      taxType: t.TaxType,
      name: typeof t.Name === 'string' ? t.Name : t.TaxType,
      rateBp: rateToBp(t.EffectiveRate),
    }))
    .filter((t) => t.rateBp != null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  CONTACT_PAGE_SIZE,
  readiness,
  assertReady,
  mapContact,
  searchContacts,
  getContact,
  salesAccounts,
  taxRates,
  rateToBp,
};
