'use strict';

// Customer stage invoices — what goes to Xero, and what it must look like
// when it comes back (#1150). PURE: no I/O, no clock, no Xero call.
//
//   blockersFor    everything that stops a stage being sent, by name
//   composeInvoice the stage's lines, dates and reference (frozen at send)
//   buildXeroBody  the exact create body for PUT /Invoices
//   requestHash / idempotencyKey   stable identity of one send
//   parseXeroInvoice  Xero's answer → integer cents + plain dates (the mirror)
//   verifyAgainst  read-back vs what was sent, mismatch by mismatch
//
// Rules (docs/architecture/customer-invoicing-boundary-adr.md):
//   * DRAFT only — the body always says Status: DRAFT (rule 2).
//   * Only ContactID in the contact element, so BuhlOS can never edit a
//     contact as a side effect (rule 8).
//   * Integer cents in, integer cents out. Amounts are sent ex GST with
//     LineAmountTypes: Exclusive; Xero works out the tax (rule 12).
//   * Retention is a NEGATIVE line on the same account and tax rate.

const crypto = require('crypto');
const { computeStage, isCents, itemsOf } = require('./amounts');

const MAX_REFERENCE = 255;
const MAX_DESCRIPTION = 4000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const JOB_CODE = /^IV\d{4}$/;

/** The invoice number for a job's nth sent stage: IV3345-2. */
function invoiceNumberFor(jobCode, seq) {
  return `${jobCode}-${seq}`;
}

/** YYYY-MM-DD + n days, in pure calendar arithmetic (UTC, no DST drift). */
function addDays(day, n) {
  if (!DAY.test(String(day || '')) || !Number.isInteger(n)) return null;
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function formatPercent(bp) {
  const pct = bp / 100;
  return `${Number.isInteger(pct) ? pct : Number(pct.toFixed(2))}%`;
}

/** Cents → the number Xero receives (dollars, at most 2 decimals, exact). */
function dollars(cents) {
  return Number((cents / 100).toFixed(2));
}

/** Xero money (number or numeric string, dollars) → integer cents, or null. */
function centsFromXero(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Xero date → YYYY-MM-DD. Prefers the ISO `…String` twin; else `/Date(ms)/`. */
function dayFromXero(dateString, msDate) {
  if (typeof dateString === 'string') {
    const m = dateString.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  if (typeof msDate === 'string') {
    const m = msDate.match(/\/Date\((-?\d+)/);
    if (m) return new Date(Number(m[1])).toISOString().slice(0, 10);
    const iso = msDate.match(/^(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
  }
  return null;
}

function timestampFromXero(utcString, msDate) {
  if (typeof utcString === 'string' && !Number.isNaN(Date.parse(utcString))) return new Date(utcString).toISOString();
  if (typeof msDate === 'string') {
    const m = msDate.match(/\/Date\((-?\d+)/);
    if (m) return new Date(Number(m[1])).toISOString();
  }
  return null;
}

/**
 * The invoice's lines, in order: the stage itself, any extra lines, then the
 * retention held back as a negative line. One place builds them, so a first
 * send and a retry from the frozen snapshot can never word them differently.
 */
function linesOf({ stage, job, baseCents, retentionBp, retentionCents, footer }) {
  const lines = chargeLines({ stage, job, baseCents, retentionBp, retentionCents });
  // Wording added at send (the payment-claim statement) goes last, with no amount.
  if (typeof footer === 'string' && footer.trim()) {
    lines.push({ description: footer.slice(0, MAX_DESCRIPTION), amountCents: 0, note: true });
  }
  return lines;
}

function chargeLines({ stage, job, baseCents, retentionBp, retentionCents }) {
  const where = [job.name || job.id, typeof job.siteAddress === 'string' && job.siteAddress.trim() ? job.siteAddress.trim() : null]
    .filter(Boolean).join(', ');
  if (stage.kind === 'itemised') return itemisedLines({ stage, where, retentionBp, retentionCents });
  const headline =
    stage.kind !== 'retention_release' && stage.basis === 'percent' && Number.isInteger(stage.percentBp)
      ? `${stage.title} (${formatPercent(stage.percentBp)} of contract)`
      : stage.title;
  const lines = [{ description: `${headline}\n${where}`.slice(0, MAX_DESCRIPTION), amountCents: baseCents }];
  for (const l of Array.isArray(stage.extraLines) ? stage.extraLines : []) {
    lines.push({ description: String(l.description).slice(0, MAX_DESCRIPTION), amountCents: l.amountCents });
  }
  if (retentionCents > 0) {
    lines.push({ description: `Less retention (${formatPercent(retentionBp)})`, amountCents: -retentionCents });
  }
  return lines;
}

/**
 * An ITEMISED invoice's lines: a wording-only first line saying what the work
 * was and where, then each charge with its quantity and unit price, the notes
 * in the order they were written, and retention (if the job has any) last.
 * Cost, markup and what job data a line bills never leave BuhlOS.
 */
function itemisedLines({ stage, where, retentionBp, retentionCents }) {
  const lines = [{ description: `${stage.title}\n${where}`.slice(0, MAX_DESCRIPTION), amountCents: 0, note: true }];
  for (const it of itemsOf(stage)) {
    if (it.type === 'note') {
      lines.push({ description: String(it.description).slice(0, MAX_DESCRIPTION), amountCents: 0, note: true });
    } else {
      lines.push({
        description: String(it.description).slice(0, MAX_DESCRIPTION),
        quantityMilli: it.quantityMilli,
        unit: it.unit,
        unitCents: it.unitCents,
        amountCents: it.amountCents,
      });
    }
  }
  if (retentionCents > 0) {
    lines.push({ description: `Less retention (${formatPercent(retentionBp)})`, amountCents: -retentionCents });
  }
  return lines;
}

/** "$12,345.60" — for wording that goes on the invoice. */
function moneyText(cents) {
  const abs = Math.abs(Math.trunc(cents));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${cents < 0 ? '-' : ''}$${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/** What s 13(2)(c) of the SA Act asks a payment claim to state. */
const CLAIM_STATEMENT =
  'This is a payment claim made under the Building and Construction Industry Security of Payment Act 2009 (SA).';

/**
 * The wording a payment claim carries (#1164): the statement, and — when the
 * job has a contract value — where the claim stands against it. `totals` is
 * the job BEFORE this invoice is sent. Amounts are ex GST, before retention.
 */
function claimFooter({ stage, grossCents, totals }) {
  const out = [CLAIM_STATEMENT];
  if (totals && Number.isInteger(totals.revisedContractCents) && Number.isInteger(grossCents)) {
    const claimed = totals.claimedCents + (stage && stage.kind === 'retention_release' ? 0 : grossCents);
    const sum = totals.variationsApprovedCents > 0 ? 'Contract sum including approved variations' : 'Contract sum';
    out.push(
      `${sum}: ${moneyText(totals.revisedContractCents)}. Claimed to date including this claim: ${moneyText(claimed)}. ` +
      `Remaining: ${moneyText(totals.revisedContractCents - claimed)}. All ex GST, before retention.`
    );
  }
  return out.join('\n');
}

/** One line as Xero receives it. A note carries wording only. */
function xeroLine(l, settings) {
  if (l.note) return { Description: l.description };
  const priced = Number.isInteger(l.quantityMilli) && Number.isInteger(l.unitCents);
  return {
    Description: l.description,
    Quantity: priced ? l.quantityMilli / 1000 : 1,
    UnitAmount: dollars(priced ? l.unitCents : l.amountCents),
    AccountCode: settings.salesAccountCode,
    TaxType: settings.taxType,
  };
}

/**
 * GST as Xero works it out: per line, rounded to the cent, then added up
 * (developer.xero.com "Rounding in Xero"). Still an ESTIMATE until Xero
 * answers — it is shown as one, and Xero's own figure replaces it.
 */
function estimateTaxCents(lines, taxRateBp) {
  if (!Number.isInteger(taxRateBp) || taxRateBp < 0) return null;
  let total = 0;
  for (const l of lines) {
    const a = Math.abs(l.amountCents);
    const t = Math.floor((a * taxRateBp + 5000) / 10000);
    total += l.amountCents < 0 ? -t : t;
  }
  return total;
}

/**
 * Everything that stops this stage being sent, each with a stable code. An
 * empty list means it can go. Decided from stored state only.
 *
 * @param {{ stage: object, job: object, profile: object|null, settings: object|null,
 *           ready: { state: string, externalTenantId: string|null }, settingsComplete: boolean }} ctx
 * @returns {Array<{ code: string }>}
 */
function blockersFor(ctx) {
  const out = [];
  const { stage, job, profile, ready } = ctx;
  if (!stage || stage.state !== 'planned') out.push({ code: 'not_planned' });
  if (!ready || ready.state !== 'connected') out.push({ code: 'xero_not_ready', state: ready ? ready.state : 'unavailable' });
  if (!ctx.settingsComplete) out.push({ code: 'settings_incomplete' });
  if (!profile || !profile.xeroContactId) out.push({ code: 'no_client_link' });
  else if (ready && ready.externalTenantId && profile.externalTenantId !== ready.externalTenantId) {
    out.push({ code: 'client_other_organisation' });
  }
  if (!job || typeof job.code !== 'string' || !JOB_CODE.test(job.code)) out.push({ code: 'no_job_code' });
  if (stage) {
    const c = computeStage(stage, { contractCents: ctx.contractCents, retentionBp: profile ? profile.retentionBp : 0 });
    if (c.grossCents == null) {
      out.push({ code: c.reason === 'no_contract_value' ? 'no_contract_value' : c.reason === 'no_lines' ? 'no_lines' : 'amount_invalid' });
    }
    else if (c.netCents <= 0) out.push({ code: 'nothing_to_invoice' });
  }
  return out;
}

/**
 * Work the stage out into the lines and dates of ONE invoice — the snapshot
 * that is frozen when the stage is sent. Returns null when the amount can't
 * be worked out (blockersFor names why).
 *
 * @param {{ stage: object, job: object, profile: object, settings: object,
 *           contractCents: number|null, invoiceDate: string, reference?: string|null }} ctx
 */
function composeInvoice(ctx) {
  const { stage, job, profile, settings } = ctx;
  const c = computeStage(stage, { contractCents: ctx.contractCents, retentionBp: profile ? profile.retentionBp : 0 });
  if (c.grossCents == null) return null;

  // The payment-claim wording (#1164) — only when the job has it switched on.
  const footer = ctx.claim ? claimFooter({ stage, grossCents: c.grossCents, totals: ctx.claim.totals }) : null;
  const lines = linesOf({ stage, job, baseCents: c.baseCents, retentionBp: c.retentionBp, retentionCents: c.retentionCents, footer });

  const invoiceDate = ctx.invoiceDate;
  const dueDate = addDays(invoiceDate, settings.paymentTermsDays);
  const fallbackRef = [job.code, job.name || job.id].filter(Boolean).join(' ');
  const reference = String(ctx.reference == null || String(ctx.reference).trim() === '' ? fallbackRef : ctx.reference)
    .trim().slice(0, MAX_REFERENCE);

  return {
    lines,
    grossCents: c.grossCents,
    retentionBp: c.retentionBp,
    retentionCents: c.retentionCents,
    netCents: c.netCents,
    invoiceDate,
    dueDate,
    reference,
    footer,
    // What Xero is expected to add — an ESTIMATE from the rate Xero gave us,
    // shown as such before sending. After sending, Xero's own figure is used.
    estimatedTaxCents: estimateTaxCents(lines, settings.taxRateBp),
  };
}

/**
 * Lines for a row that has ALREADY been frozen (a retry): the stored snapshot,
 * never re-derived from a contract value that may have changed since.
 */
function composeFromSnapshot(row, job) {
  if (!isCents(row.grossCents) || !Number.isInteger(row.netCents)) return null;
  const extras = (Array.isArray(row.extraLines) ? row.extraLines : []).reduce((s, l) => s + l.amountCents, 0);
  const retentionCents = Number.isInteger(row.retentionCents) ? row.retentionCents : 0;
  return {
    lines: linesOf({
      stage: row,
      job,
      baseCents: row.grossCents - extras,
      retentionBp: row.retentionBp == null ? 0 : row.retentionBp,
      retentionCents,
      // exactly the wording that was frozen when it was first sent
      footer: row.sentFooter || null,
    }),
    footer: row.sentFooter || null,
    grossCents: row.grossCents,
    retentionCents,
    netCents: row.netCents,
    invoiceDate: row.invoiceDate,
    dueDate: row.dueDate,
    reference: row.reference,
  };
}

/**
 * The exact body for `PUT {ACCOUNTING_BASE}/Invoices` (create-only).
 * @param {{ invoiceNumber: string, contactId: string, composed: object,
 *           settings: { salesAccountCode: string, taxType: string }, url?: string|null }} p
 */
function buildXeroBody(p) {
  const invoice = {
    Type: 'ACCREC',
    Status: 'DRAFT',
    LineAmountTypes: 'Exclusive',
    Contact: { ContactID: p.contactId },
    InvoiceNumber: p.invoiceNumber,
    Reference: p.composed.reference,
    Date: p.composed.invoiceDate,
    DueDate: p.composed.dueDate,
    LineItems: p.composed.lines.map((l) => xeroLine(l, p.settings)),
  };
  if (p.url) invoice.Url = p.url;
  return { Invoices: [invoice] };
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** Stable hash of exactly what is sent. */
function requestHash(body) {
  return sha256(JSON.stringify(body));
}

/**
 * The Idempotency-Key for one send of one invoice: the same invoice with the
 * same body always carries the same key (Xero replays instead of creating a
 * second one); a changed body is a different request. 64 hex chars (≤ 128).
 */
function idempotencyKey(invoiceId, hash) {
  return sha256(`customer-invoice:${invoiceId}:${hash}`);
}

/** Where the job lives in BuhlOS — shown in Xero as "Go to BuhlOS". */
function jobUrl(appBaseUrl, jobId) {
  return appBaseUrl ? `${appBaseUrl}/v2/jobs/${encodeURIComponent(jobId)}` : null;
}

/** First invoice in a Xero response (create, single GET, or list). */
function firstInvoice(data) {
  const list = data && Array.isArray(data.Invoices) ? data.Invoices : null;
  return list && list.length ? list[0] : null;
}

/**
 * Xero's invoice → the mirror BuhlOS stores: status, integer-cent amounts,
 * plain dates. Xero's figures win for anything sent (ADR rule 6).
 */
function parseXeroInvoice(inv) {
  if (!inv || typeof inv !== 'object') return null;
  const lines = Array.isArray(inv.LineItems) ? inv.LineItems : null;
  return {
    xeroInvoiceId: typeof inv.InvoiceID === 'string' ? inv.InvoiceID : null,
    invoiceNumber: typeof inv.InvoiceNumber === 'string' ? inv.InvoiceNumber : null,
    type: typeof inv.Type === 'string' ? inv.Type : null,
    status: typeof inv.Status === 'string' ? inv.Status.toUpperCase() : null,
    contactId: inv.Contact && typeof inv.Contact.ContactID === 'string' ? inv.Contact.ContactID : null,
    subtotalCents: centsFromXero(inv.SubTotal),
    taxCents: centsFromXero(inv.TotalTax),
    totalCents: centsFromXero(inv.Total),
    amountDueCents: centsFromXero(inv.AmountDue),
    amountPaidCents: centsFromXero(inv.AmountPaid),
    amountCreditedCents: centsFromXero(inv.AmountCredited),
    dueDate: dayFromXero(inv.DueDateString, inv.DueDate),
    fullyPaidOn: dayFromXero(inv.FullyPaidOnDateString, inv.FullyPaidOnDate),
    updatedAt: timestampFromXero(inv.UpdatedDateUTCString, inv.UpdatedDateUTC),
    // null when Xero answered without line items (a summary / list read)
    lineCents: lines
      ? lines.map((l) => centsFromXero(l.LineAmount != null ? l.LineAmount : Number(l.UnitAmount) * Number(l.Quantity == null ? 1 : l.Quantity)))
      : null,
  };
}

const KNOWN_STATUS = new Set(['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID', 'VOIDED', 'DELETED']);

/**
 * Compare Xero's invoice with what BuhlOS sent. `mismatches` is empty when it
 * landed as sent. `requireDraft` is true straight after a create (it must be
 * a draft); false when adopting an invoice found later (the office may have
 * approved it since — that is not a mismatch).
 *
 * @param {object} got  parseXeroInvoice() output
 * @param {{ invoiceNumber: string, contactId: string, netCents: number, lineCents: number[] }} sent
 */
function verifyAgainst(got, sent, { requireDraft = true } = {}) {
  if (!got) return { verified: false, mismatches: ['readback_empty'] };
  const mism = [];
  if (got.type !== 'ACCREC') mism.push(`type:${got.type}`);
  if (got.invoiceNumber !== sent.invoiceNumber) mism.push('invoice_number');
  if (got.contactId !== sent.contactId) mism.push('contact');
  if (!KNOWN_STATUS.has(String(got.status))) mism.push(`status:${got.status}`);
  else if (requireDraft && got.status !== 'DRAFT') mism.push(`status:${got.status}`);
  if (got.subtotalCents !== sent.netCents) mism.push('subtotal');
  if (got.lineCents) {
    // Wording-only lines carry no amount on either side, so only the charges
    // are compared.
    const charges = (list) => list.filter((c) => Number.isInteger(c) && c !== 0).sort((x, y) => x - y).join(',');
    const a = charges(got.lineCents);
    const b = charges(sent.lineCents);
    if (a !== b) mism.push('lines');
  }
  return { verified: mism.length === 0, mismatches: mism };
}

/** Does Xero's refusal say the invoice number is already used? */
function isNumberTaken(detail) {
  return /must be unique|already exists|already been used|duplicate/i.test(String(detail || ''));
}

module.exports = {
  MAX_REFERENCE,
  invoiceNumberFor,
  addDays,
  dollars,
  centsFromXero,
  dayFromXero,
  blockersFor,
  composeInvoice,
  composeFromSnapshot,
  buildXeroBody,
  requestHash,
  idempotencyKey,
  jobUrl,
  firstInvoice,
  parseXeroInvoice,
  verifyAgainst,
  isNumberTaken,
  isCents,
  estimateTaxCents,
  claimFooter,
  CLAIM_STATEMENT,
  moneyText,
};
