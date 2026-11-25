'use strict';

// Customer stage invoices — the ONE write to Xero: create a DRAFT sales
// invoice for a stage (#1150; rules:
// docs/architecture/customer-invoicing-boundary-adr.md). Modelled on the
// draft-timesheet export (api/_lib/xero/timesheet-export.js).
//
//   preview   what would be sent and what is stopping it — writes nothing
//   send      claim the stage (number allocated, snapshot frozen) → create → read back
//   retry     LOOK THE NUMBER UP FIRST → adopt what Xero has, or send again
//   reset     put a stage that never reached Xero back to planned
//
// A SEND CAN NEVER DUPLICATE (ADR rule 4) — three independent guards:
//   1. the row is moved planned → sending by a guarded UPDATE before the call;
//   2. the invoice number (<job code>-<n>) is unique in Xero;
//   3. an Idempotency-Key derived from the invoice and its exact body.
// and any second attempt looks the number up in Xero and adopts what it finds
// instead of creating again.
//
// "SENT" MEANS READ BACK AND MATCHED (rule 5): the `pending` event is written
// BEFORE the call; every attempt is an immutable row; after Xero accepts, the
// invoice is read back and compared. A mismatch is recorded and shown, never
// hidden. BuhlOS only ever creates a DRAFT (rule 2) with a create-only PUT
// (rule 3) — it never approves, emails, edits, voids or deletes in Xero.

const crypto = require('crypto');
const { ACCOUNTING_BASE, appBaseUrl } = require('../xero/config');
const { XeroError } = require('../xero/errors');
const client = require('../xero/client');
const lookups = require('./xero-lookups');
const defaultStore = require('./store');
const { contractCentsOf, jobTotals } = require('./amounts');
const P = require('./payload');
const noJob = require('./no-job');

// Xero answered and created nothing → the stage is `failed` (safe to fix and resend).
const DEFINITE = new Set([
  'validation', 'forbidden', 'auth', 'reconnect_required', 'not_connected',
  'pending_selection', 'not_configured', 'rate_limit', 'conflict', 'not_found',
]);

function depsOf(d) {
  const deps = d || {};
  return {
    sql: deps.sql,
    store: deps.store || defaultStore,
    xeroFetch: deps.xeroFetch || client.xeroFetch,
    lookups: deps.lookups || lookups,
    env: deps.env || process.env,
    newId: deps.newId || (() => crypto.randomUUID()),
    fetchDeps: { sql: deps.sql, store: deps.tokenStore, env: deps.env, fetchImpl: deps.fetchImpl },
  };
}

function sydneyToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/**
 * Everything a send decision is made from — stored rows only, no Xero call.
 * A no-job invoice (#1166) has no job profile: its client is the one chosen
 * on the invoice, it holds no retention and carries no payment-claim wording.
 */
async function loadContext(d, tenantId, job, invoice) {
  const ready = await d.lookups.readiness({ sql: d.sql, env: d.env });
  const [profile, settings] = await Promise.all([
    job.noJob ? noJob.profileOf(invoice) : d.store.getProfile(d.sql, tenantId, job.id),
    d.store.getSettings(d.sql, tenantId, ready.externalTenantId),
  ]);
  const contractCents = contractCentsOf(job.contractValue);
  // The job's standing before this invoice — only read when the job's
  // invoices carry payment-claim wording (#1164).
  let claim = null;
  if (profile && profile.paymentClaim) {
    const [rows, variations] = await Promise.all([
      d.store.listJobInvoices(d.sql, tenantId, job.id),
      d.store.listVariations ? d.store.listVariations(d.sql, tenantId, job.id) : [],
    ]);
    claim = { totals: jobTotals(rows, { contractCents, retentionBp: profile.retentionBp, variations }) };
  }
  return {
    ready,
    profile,
    settings,
    settingsComplete: d.store.settingsComplete(settings),
    contractCents,
    claim,
  };
}

function presentable(composed, settings, invoiceNumber, ctx) {
  return {
    invoiceNumber,
    organisationName: ctx.ready.organisationName,
    contactName: ctx.profile ? ctx.profile.xeroContactName : null,
    invoiceDate: composed.invoiceDate,
    dueDate: composed.dueDate,
    reference: composed.reference,
    lines: composed.lines,
    netCents: composed.netCents,
    estimatedTaxCents: composed.estimatedTaxCents,
    estimatedTotalCents: composed.estimatedTaxCents == null ? null : composed.netCents + composed.estimatedTaxCents,
    salesAccountCode: settings.salesAccountCode,
    salesAccountName: settings.salesAccountName,
    taxName: settings.taxName,
    taxRateBp: settings.taxRateBp,
  };
}

/**
 * What would be sent, and everything stopping it. Writes nothing, calls Xero
 * for nothing.
 */
async function preview({ tenant, invoice, job, options = {}, deps }) {
  const d = depsOf(deps);
  const ctx = await loadContext(d, tenant.id, job, invoice);
  const blockers = P.blockersFor({ stage: invoice, job, profile: ctx.profile, settings: ctx.settings, ready: ctx.ready, settingsComplete: ctx.settingsComplete, contractCents: ctx.contractCents });
  let shown = null;
  if (ctx.settingsComplete && (job.noJob || typeof job.code === 'string')) {
    const composed = P.composeInvoice({
      stage: invoice, job, profile: ctx.profile || { retentionBp: 0 }, settings: ctx.settings,
      contractCents: ctx.contractCents, claim: ctx.claim,
      invoiceDate: options.invoiceDate || sydneyToday(), reference: options.reference,
    });
    if (composed) {
      const seq = await d.store.peekNextSeq(d.sql, tenant.id, job.id);
      shown = presentable(composed, ctx.settings, P.numberOf(job, seq), ctx);
    }
  }
  return { blockers, invoice: shown };
}

// ── settling an attempt ─────────────────────────────────────────────────────

function sentShape(row, composed) {
  return {
    invoiceNumber: row.invoiceNumber,
    contactId: row.xeroContactId,
    netCents: row.netCents,
    lineCents: composed.lines.map((l) => l.amountCents),
  };
}

/**
 * Xero has the invoice (`xeroInvoiceId`). Read it back, compare, store Xero's
 * figures and move the row to `sent`. A failed or mismatched read-back still
 * records the invoice — with the drift named — because it DOES exist in Xero.
 */
async function settleFound(d, tenant, row, composed, { xeroInvoiceId, fallback, attemptId, actor, adopted }) {
  let got = null;
  let readProblem = null;
  try {
    const resp = await d.xeroFetch(`${ACCOUNTING_BASE}/Invoices/${xeroInvoiceId}`, { deps: d.fetchDeps });
    got = P.parseXeroInvoice(P.firstInvoice(resp && resp.data));
  } catch (e) {
    readProblem = `readback_failed:${e instanceof XeroError ? e.category : 'unexpected'}`;
  }
  const check = got
    ? P.verifyAgainst(got, sentShape(row, composed), { requireDraft: !adopted })
    : { verified: false, mismatches: [readProblem || 'readback_empty'] };
  const mirror = got || fallback;
  const drift = check.verified ? null : { mismatches: check.mismatches, at: new Date().toISOString() };
  const updated = await d.store.markAccepted(d.sql, tenant.id, row.id, { xeroInvoiceId, mirror, drift });
  await d.store.insertEvent(d.sql, tenant.id, {
    invoiceId: row.id, jobId: row.jobId, attemptId, actor,
    event: check.verified ? 'verified_against_xero' : 'drifted',
    detail: check.verified ? { xeroInvoiceId } : { xeroInvoiceId, mismatches: check.mismatches },
  });
  return {
    outcome: adopted ? 'adopted' : 'sent',
    verified: check.verified,
    mismatches: check.mismatches,
    xeroInvoiceId,
    invoiceNumber: row.invoiceNumber,
    row: updated,
  };
}

/** Create the draft in Xero and settle whatever comes back. */
async function putAndSettle(d, tenant, row, composed, settings, { actor }) {
  const body = P.buildXeroBody({
    invoiceNumber: row.invoiceNumber,
    contactId: row.xeroContactId,
    composed,
    settings,
    url: P.jobUrl(appBaseUrl(d.env), row.jobId),
  });
  const hash = P.requestHash(body);
  const key = P.idempotencyKey(row.id, hash);
  const attemptId = d.newId();
  const attempt = {
    id: attemptId, invoiceId: row.id, externalTenantId: row.externalTenantId, invoiceNumber: row.invoiceNumber,
    contentHash: row.contentHash || hash, requestHash: hash, idempotencyKey: key, actor,
  };

  // PENDING FIRST — if anything dies after this line, the row is still
  // `sending` with a pending event, and the next step is a look-up.
  await d.store.insertEvent(d.sql, tenant.id, {
    invoiceId: row.id, jobId: row.jobId, attemptId, event: 'pending', actor,
    detail: { invoiceNumber: row.invoiceNumber, requestHash: hash },
  });

  let resp;
  try {
    resp = await d.xeroFetch(`${ACCOUNTING_BASE}/Invoices`, {
      method: 'PUT', body, headers: { 'Idempotency-Key': key }, deps: d.fetchDeps,
    });
  } catch (e) {
    if (!(e instanceof XeroError)) throw e;
    return settleError(d, tenant, row, attempt, e, { actor });
  }

  const created = P.parseXeroInvoice(P.firstInvoice(resp && resp.data));
  if (!created || !created.xeroInvoiceId) {
    // A 200 with no invoice id: Xero's state is unknown. Never guess.
    await d.store.insertAttempt(d.sql, tenant.id, { ...attempt, outcome: 'error', httpStatus: 200, correlationId: resp && resp.correlationId, errorCategory: 'unexpected', errorDetail: 'no_invoice_id_in_response' });
    await d.store.noteUnknown(d.sql, tenant.id, row.id, { category: 'unexpected', detail: 'Xero answered without an invoice id.' });
    await d.store.insertEvent(d.sql, tenant.id, { invoiceId: row.id, jobId: row.jobId, attemptId, event: 'retry_required', actor, detail: { category: 'unexpected' } });
    return { outcome: 'unknown', category: 'unexpected', invoiceNumber: row.invoiceNumber };
  }

  await d.store.insertAttempt(d.sql, tenant.id, { ...attempt, outcome: 'accepted', httpStatus: 200, xeroInvoiceId: created.xeroInvoiceId, correlationId: resp.correlationId });
  await d.store.insertEvent(d.sql, tenant.id, { invoiceId: row.id, jobId: row.jobId, attemptId, event: 'accepted_by_xero', actor, detail: { xeroInvoiceId: created.xeroInvoiceId } });
  return settleFound(d, tenant, row, composed, { xeroInvoiceId: created.xeroInvoiceId, fallback: created, attemptId, actor, adopted: false });
}

/** Xero (or the network) said no. Definite refusal → failed; no answer → still sending. */
async function settleError(d, tenant, row, attempt, err, { actor }) {
  const definite = DEFINITE.has(err.category);
  // XeroError carries its safe detail only inside the message: "xero: cat (detail)".
  const m = /^xero: [a-z_]+ \((.*)\)$/s.exec(String(err.message || ''));
  const said = m && m[1] !== 'api_request' ? m[1] : null;
  const category = err.category === 'validation' && P.isNumberTaken(said) ? 'number_taken' : err.category;
  await d.store.insertAttempt(d.sql, tenant.id, {
    ...attempt, outcome: definite ? 'rejected' : 'error', httpStatus: err.status, correlationId: err.correlationId,
    errorCategory: category, errorDetail: said,
  });
  if (definite) {
    await d.store.markFailed(d.sql, tenant.id, row.id, { category, detail: said });
    await d.store.insertEvent(d.sql, tenant.id, { invoiceId: row.id, jobId: row.jobId, attemptId: attempt.id, event: 'rejected', actor, detail: { category, said } });
    return { outcome: 'failed', category, detail: said, invoiceNumber: row.invoiceNumber, retryAfterSeconds: err.retryAfterSeconds };
  }
  await d.store.noteUnknown(d.sql, tenant.id, row.id, { category, detail: said });
  await d.store.insertEvent(d.sql, tenant.id, { invoiceId: row.id, jobId: row.jobId, attemptId: attempt.id, event: 'retry_required', actor, detail: { category } });
  return { outcome: 'unknown', category, invoiceNumber: row.invoiceNumber };
}

// ── send ────────────────────────────────────────────────────────────────────

/**
 * Send a PLANNED stage to Xero as a draft.
 * @returns {{ outcome: 'blocked'|'sent'|'failed'|'unknown', ... }}
 */
async function send({ tenant, invoice, job, options = {}, actor, deps }) {
  const d = depsOf(deps);
  const ctx = await loadContext(d, tenant.id, job, invoice);
  const blockers = P.blockersFor({ stage: invoice, job, profile: ctx.profile, settings: ctx.settings, ready: ctx.ready, settingsComplete: ctx.settingsComplete, contractCents: ctx.contractCents });
  if (blockers.length) return { outcome: 'blocked', blockers };

  const composed = P.composeInvoice({
    stage: invoice, job, profile: ctx.profile, settings: ctx.settings, contractCents: ctx.contractCents, claim: ctx.claim,
    invoiceDate: options.invoiceDate || sydneyToday(), reference: options.reference,
  });
  if (!composed || !composed.dueDate) return { outcome: 'blocked', blockers: [{ code: 'amount_invalid' }] };

  const url = P.jobUrl(appBaseUrl(d.env), job.id);
  // Claim the stage: number allocated, snapshot frozen, state → sending.
  // A second request loses here (StoreConflict) before anything reaches Xero.
  const row = await d.store.beginSend(d.sql, tenant.id, invoice.id, {
    jobCode: job.code,
    // a no-job invoice is numbered from its own series (#1166)
    numberFor: job.noJob ? noJob.numberFor : null,
    grossCents: composed.grossCents,
    retentionBp: composed.retentionBp,
    retentionCents: composed.retentionCents,
    netCents: composed.netCents,
    invoiceDate: composed.invoiceDate,
    dueDate: composed.dueDate,
    reference: composed.reference,
    footer: composed.footer || null,
    externalTenantId: ctx.ready.externalTenantId,
    xeroContactId: ctx.profile.xeroContactId,
    xeroContactName: ctx.profile.xeroContactName,
    build: (invoiceNumber) =>
      P.requestHash(P.buildXeroBody({ invoiceNumber, contactId: ctx.profile.xeroContactId, composed, settings: ctx.settings, url })),
  }, { expectedVersion: options.expectedVersion, actor });

  return putAndSettle(d, tenant, row, composed, ctx.settings, { actor });
}

// ── retry / reset: always look the number up first ──────────────────────────

/** Can this claimed row be resolved against the Xero that is connected now? */
function resolvable(row, ctx) {
  if (!row || !row.seq || !row.invoiceNumber || row.xeroInvoiceId) return [{ code: 'not_awaiting_xero' }];
  if (row.state !== 'sending' && row.state !== 'failed') return [{ code: 'not_awaiting_xero' }];
  if (ctx.ready.state !== 'connected') return [{ code: 'xero_not_ready', state: ctx.ready.state }];
  // The number was claimed in ONE organisation; only that one can say whether it exists.
  if (row.externalTenantId !== ctx.ready.externalTenantId) return [{ code: 'other_organisation' }];
  return [];
}

/**
 * What does Xero hold under this row's number?
 *   { kind: 'none' }                      nothing — safe to send or release the number
 *   { kind: 'ours', got }                 our invoice, live — adopt it
 *   { kind: 'taken', why }                something else, or ours but deleted/voided — the number is burned
 */
async function lookUp(d, row, composed) {
  const url = `${ACCOUNTING_BASE}/Invoices?InvoiceNumbers=${encodeURIComponent(row.invoiceNumber)}`;
  const resp = await d.xeroFetch(url, { deps: d.fetchDeps });
  const list = resp && resp.data && Array.isArray(resp.data.Invoices) ? resp.data.Invoices : [];
  const hits = list.map(P.parseXeroInvoice).filter((g) => g && g.invoiceNumber === row.invoiceNumber);
  if (!hits.length) return { kind: 'none' };
  const sales = hits.find((g) => g.type === 'ACCREC');
  if (!sales || !sales.xeroInvoiceId) return { kind: 'taken', why: 'another kind of document uses this number in Xero' };
  if (sales.status === 'DELETED' || sales.status === 'VOIDED') {
    return { kind: 'taken', why: `Xero has a ${sales.status === 'DELETED' ? 'deleted' : 'voided'} invoice with this number` };
  }
  // The list answer has no line items; the single read does.
  const full = await d.xeroFetch(`${ACCOUNTING_BASE}/Invoices/${sales.xeroInvoiceId}`, { deps: d.fetchDeps });
  const got = P.parseXeroInvoice(P.firstInvoice(full && full.data)) || sales;
  const check = P.verifyAgainst(got, sentShape(row, composed), { requireDraft: false });
  if (!check.verified) return { kind: 'taken', why: 'Xero already has a different invoice with this number' };
  return { kind: 'ours', got };
}

async function markTaken(d, tenant, row, why, { actor }) {
  const attemptId = d.newId();
  await d.store.insertAttempt(d.sql, tenant.id, {
    id: attemptId, invoiceId: row.id, externalTenantId: row.externalTenantId, invoiceNumber: row.invoiceNumber,
    contentHash: row.contentHash || 'unknown', outcome: 'blocked', errorCategory: 'number_taken', errorDetail: why, actor,
  });
  await d.store.markFailed(d.sql, tenant.id, row.id, { category: 'number_taken', detail: why });
  await d.store.insertEvent(d.sql, tenant.id, { invoiceId: row.id, jobId: row.jobId, attemptId, event: 'rejected', actor, detail: { category: 'number_taken', why } });
  return { outcome: 'failed', category: 'number_taken', detail: why, invoiceNumber: row.invoiceNumber };
}

async function adopt(d, tenant, row, composed, got, { actor }) {
  const attemptId = d.newId();
  await d.store.insertAttempt(d.sql, tenant.id, {
    id: attemptId, invoiceId: row.id, externalTenantId: row.externalTenantId, invoiceNumber: row.invoiceNumber,
    contentHash: row.contentHash || 'unknown', outcome: 'adopted', xeroInvoiceId: got.xeroInvoiceId, actor,
  });
  await d.store.insertEvent(d.sql, tenant.id, { invoiceId: row.id, jobId: row.jobId, attemptId, event: 'adopted', actor, detail: { xeroInvoiceId: got.xeroInvoiceId } });
  return settleFound(d, tenant, row, composed, { xeroInvoiceId: got.xeroInvoiceId, fallback: got, attemptId, actor, adopted: true });
}

/**
 * Resolve a stage stuck `sending` or `failed`: look its number up in Xero.
 * Found and ours → adopt (no second create). Taken by something else → say
 * so. Not there → send again, from the FROZEN snapshot with the current
 * account and tax defaults.
 * @returns {{ outcome: 'blocked'|'adopted'|'sent'|'failed'|'unknown', ... }}
 */
async function retry({ tenant, invoice, job, actor, deps }) {
  const d = depsOf(deps);
  const ctx = await loadContext(d, tenant.id, job, invoice);
  const blockers = resolvable(invoice, ctx);
  if (!blockers.length && !ctx.settingsComplete) blockers.push({ code: 'settings_incomplete' });
  if (blockers.length) return { outcome: 'blocked', blockers };
  const composed = P.composeFromSnapshot(invoice, job);
  if (!composed) return { outcome: 'blocked', blockers: [{ code: 'amount_invalid' }] };

  const found = await lookUp(d, invoice, composed);
  if (found.kind === 'ours') return adopt(d, tenant, invoice, composed, found.got, { actor });
  if (found.kind === 'taken') return markTaken(d, tenant, invoice, found.why, { actor });
  return putAndSettle(d, tenant, invoice, composed, ctx.settings, { actor });
}

/**
 * Put a stage that never reached Xero back to `planned` (to edit and resend).
 * Its number is only released once Xero confirms it holds nothing under it;
 * if Xero has our invoice after all, it is adopted instead.
 * @returns {{ outcome: 'blocked'|'reset'|'adopted'|'failed', ... }}
 */
async function reset({ tenant, invoice, job, actor, deps }) {
  const d = depsOf(deps);
  const ctx = await loadContext(d, tenant.id, job, invoice);
  const blockers = resolvable(invoice, ctx);
  if (blockers.length) return { outcome: 'blocked', blockers };
  const composed = P.composeFromSnapshot(invoice, job);
  if (!composed) return { outcome: 'blocked', blockers: [{ code: 'amount_invalid' }] };

  const found = await lookUp(d, invoice, composed);
  if (found.kind === 'ours') return adopt(d, tenant, invoice, composed, found.got, { actor });
  if (found.kind === 'taken') return markTaken(d, tenant, invoice, found.why, { actor });
  const row = await d.store.resetToPlanned(d.sql, tenant.id, invoice.id, { actor });
  return { outcome: 'reset', row };
}

module.exports = { preview, send, retry, reset, sydneyToday, DEFINITE };
