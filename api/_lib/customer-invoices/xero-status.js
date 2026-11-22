'use strict';

// Customer stage invoices — what happened to an invoice AFTER it was sent
// (#1151; rules: docs/architecture/customer-invoicing-boundary-adr.md).
// READS ONLY. BuhlOS asks Xero for the status and amounts of the invoices it
// created and mirrors the answer onto each row.
//
//   checkInvoices  ask Xero about a set of sent rows and write what moved
//   refreshJob     "Check Xero now" for one job
//   pollAll        the hourly check across every job
//
// XERO'S FIGURES WIN (ADR rule 6): status, subtotal, tax, total, amount paid,
// amount due and the dates are stored exactly as Xero reports them. BuhlOS
// never works out "paid" for itself, and never changes anything in Xero.
//
// The office is free to edit, approve, delete or void an invoice in Xero.
// BuhlOS follows: an edit shows as "changed in Xero" (drift), a deleted or
// voided invoice drops out of the job's totals and can be raised again.

const { ACCOUNTING_BASE } = require('../xero/config');
const { XeroError } = require('../xero/errors');
const client = require('../xero/client');
const lookups = require('./xero-lookups');
const defaultStore = require('./store');
const P = require('./payload');

// Xero invoice ids are GUIDs; 40 of them keep the URL comfortably short.
const BATCH = 40;
const DEAD = new Set(['DELETED', 'VOIDED']);

function depsOf(d) {
  const deps = d || {};
  return {
    sql: deps.sql,
    store: deps.store || defaultStore,
    xeroFetch: deps.xeroFetch || client.xeroFetch,
    lookups: deps.lookups || lookups,
    env: deps.env || process.env,
    now: deps.now || (() => Date.now()),
    fetchDeps: { sql: deps.sql, store: deps.tokenStore, env: deps.env, fetchImpl: deps.fetchImpl },
  };
}

const MIRROR_FIELDS = [
  ['status', 'xeroStatus'],
  ['subtotalCents', 'xeroSubtotalCents'],
  ['taxCents', 'xeroTaxCents'],
  ['totalCents', 'xeroTotalCents'],
  ['amountDueCents', 'xeroAmountDueCents'],
  ['amountPaidCents', 'xeroAmountPaidCents'],
  ['amountCreditedCents', 'xeroAmountCreditedCents'],
  ['dueDate', 'xeroDueDate'],
  ['fullyPaidOn', 'xeroFullyPaidOn'],
];

/** Which of Xero's figures differ from what the row holds. */
function whatMoved(row, got) {
  return MIRROR_FIELDS.filter(([g, r]) => (got[g] == null ? null : got[g]) !== (row[r] == null ? null : row[r])).map(([g]) => g);
}

/**
 * Does Xero's invoice still match what BuhlOS sent? Only what a status read
 * can see is judged (number, contact, subtotal) — line items aren't in it. A
 * dead invoice is not "drifted": it is deleted or voided, which the status
 * says. A `lines` mismatch found at the send's read-back is kept, because
 * this read can neither confirm nor clear it.
 */
function driftOf(row, got, at) {
  if (DEAD.has(String(got.status))) return null;
  const mism = [];
  if (got.invoiceNumber && got.invoiceNumber !== row.invoiceNumber) mism.push('invoice_number');
  if (got.contactId && row.xeroContactId && got.contactId !== row.xeroContactId) mism.push('contact');
  if (Number.isInteger(got.subtotalCents) && Number.isInteger(row.netCents) && got.subtotalCents !== row.netCents) mism.push('subtotal');
  const before = row.drift && Array.isArray(row.drift.mismatches) ? row.drift.mismatches : [];
  if (!mism.length && before.includes('lines')) mism.push('lines');
  if (!mism.length) return null;
  // Keep the time the difference was first seen.
  const same = before.length === mism.length && before.every((m) => mism.includes(m));
  return { mismatches: mism, at: same && row.drift.at ? row.drift.at : at };
}

const driftKey = (d) => (d && Array.isArray(d.mismatches) ? d.mismatches.slice().sort().join(',') : '');

async function fetchBatch(d, ids) {
  const resp = await d.xeroFetch(`${ACCOUNTING_BASE}/Invoices?IDs=${ids.map(encodeURIComponent).join(',')}`, { deps: d.fetchDeps });
  const list = resp && resp.data && Array.isArray(resp.data.Invoices) ? resp.data.Invoices : [];
  const byId = new Map();
  for (const g of list.map(P.parseXeroInvoice)) if (g && g.xeroInvoiceId) byId.set(g.xeroInvoiceId, g);
  return byId;
}

/** One invoice by id — for an id the list answer left out. null = Xero has none. */
async function fetchOne(d, xeroInvoiceId) {
  try {
    const resp = await d.xeroFetch(`${ACCOUNTING_BASE}/Invoices/${encodeURIComponent(xeroInvoiceId)}`, { deps: d.fetchDeps });
    return P.parseXeroInvoice(P.firstInvoice(resp && resp.data));
  } catch (e) {
    if (e instanceof XeroError && e.category === 'not_found') return null;
    throw e;
  }
}

/**
 * Ask Xero about `rows` (sent invoices, all in the connected organisation)
 * and write what moved. A Xero failure THROWS — nothing is guessed; rows
 * already written in earlier batches stay written.
 *
 * @returns {{ checked: number, changed: number, notFound: number, stoppedEarly: boolean,
 *             changes: Array<{ id, invoiceNumber, jobId, from, to }> }}
 */
async function checkInvoices({ tenant, rows, deps, deadline }) {
  const d = depsOf(deps);
  const out = { checked: 0, changed: 0, notFound: 0, stoppedEarly: false, changes: [] };
  const list = (rows || []).filter((r) => r && r.state === 'sent' && r.xeroInvoiceId);

  for (let i = 0; i < list.length; i += BATCH) {
    if (deadline && d.now() > deadline) { out.stoppedEarly = true; break; }
    const batch = list.slice(i, i + BATCH);
    const byId = await fetchBatch(d, batch.map((r) => r.xeroInvoiceId));
    const at = new Date(d.now()).toISOString();
    const unchanged = [];

    for (const row of batch) {
      let got = byId.get(row.xeroInvoiceId);
      // The list answer may leave an invoice out; ask for it by itself before
      // concluding anything.
      if (!got) got = await fetchOne(d, row.xeroInvoiceId);
      out.checked += 1;

      if (!got) {
        // Xero has no invoice under the id we stored. Keep the last figures
        // Xero gave (never invent a status) and say so on the row.
        out.notFound += 1;
        const drift = { mismatches: ['not_found_in_xero'], at: row.drift && driftKey(row.drift) === 'not_found_in_xero' ? row.drift.at : at };
        if (driftKey(row.drift) !== 'not_found_in_xero') {
          await d.store.applyMirror(d.sql, tenant.id, row.id, {
            mirror: mirrorOfRow(row), drift, event: { notFoundInXero: true },
          });
          out.changed += 1;
          out.changes.push({ id: row.id, invoiceNumber: row.invoiceNumber, jobId: row.jobId, from: row.xeroStatus, to: row.xeroStatus, notFound: true });
        } else {
          unchanged.push(row.id);
        }
        continue;
      }

      const moved = whatMoved(row, got);
      const drift = driftOf(row, got, at);
      const driftMoved = driftKey(drift) !== driftKey(row.drift);
      if (!moved.length && !driftMoved) { unchanged.push(row.id); continue; }

      await d.store.applyMirror(d.sql, tenant.id, row.id, {
        mirror: got,
        drift,
        event: {
          moved,
          from: { status: row.xeroStatus, amountPaidCents: row.xeroAmountPaidCents, amountDueCents: row.xeroAmountDueCents, subtotalCents: row.xeroSubtotalCents },
          to: { status: got.status, amountPaidCents: got.amountPaidCents, amountDueCents: got.amountDueCents, subtotalCents: got.subtotalCents },
          ...(drift ? { drift: drift.mismatches } : {}),
        },
      });
      out.changed += 1;
      out.changes.push({ id: row.id, invoiceNumber: row.invoiceNumber, jobId: row.jobId, from: row.xeroStatus, to: got.status });
    }
    await d.store.touchChecked(d.sql, tenant.id, unchanged);
  }
  return out;
}

/** The mirror a row already holds, in parseXeroInvoice's shape. */
function mirrorOfRow(row) {
  return {
    status: row.xeroStatus,
    subtotalCents: row.xeroSubtotalCents,
    taxCents: row.xeroTaxCents,
    totalCents: row.xeroTotalCents,
    amountDueCents: row.xeroAmountDueCents,
    amountPaidCents: row.xeroAmountPaidCents,
    amountCreditedCents: row.xeroAmountCreditedCents,
    dueDate: row.xeroDueDate,
    fullyPaidOn: row.xeroFullyPaidOn,
    updatedAt: row.xeroUpdatedAt,
  };
}

/**
 * "Check Xero now" for one job: every invoice the job has in the connected
 * organisation, whatever its status. Throws the typed error when Xero can't
 * be used (the handler words it).
 */
async function refreshJob({ tenant, job, deps }) {
  const d = depsOf(deps);
  const ready = await d.lookups.readiness({ sql: d.sql, env: d.env });
  d.lookups.assertReady(ready);
  const rows = await d.store.listJobSent(d.sql, tenant.id, job.id, ready.externalTenantId);
  return checkInvoices({ tenant, rows, deps });
}

/**
 * The hourly check: every sent invoice in the connected organisation that is
 * not yet settled (see store.listForStatusCheck). Returns `skipped` — with
 * the reason — when Xero isn't usable; that is not a failure of the check.
 */
async function pollAll({ tenant, deps, budgetMs = 45000 }) {
  const d = depsOf(deps);
  const ready = await d.lookups.readiness({ sql: d.sql, env: d.env });
  if (ready.state !== 'connected') return { skipped: ready.state, checked: 0, changed: 0, notFound: 0, stoppedEarly: false, changes: [] };
  const rows = await d.store.listForStatusCheck(d.sql, tenant.id, ready.externalTenantId);
  return checkInvoices({ tenant, rows, deps, deadline: d.now() + budgetMs });
}

module.exports = { BATCH, whatMoved, driftOf, checkInvoices, refreshJob, pollAll };
