'use strict';

// Automatic booking of CLEAN supplier invoices — the rule set, pure.
//
// Software may book a cost only when the document itself proves every fact a
// person would have checked, and only after a grace window in which a person
// could have stopped it. Every check below is deterministic and is recorded on
// the invoice so an auto-booking is always explainable. Anything that fails a
// check stays human. (docs/invoice-capture.md "Auto-booking".)

const { ALLOCATABLE_TYPES } = require('./state');

/** The synthetic actor an automatic booking is attributed to. */
const AUTO_ACTOR = Object.freeze({ id: '__auto__', name: 'BuhlOS (auto)', role: 'system' });

const CHECK_LABELS = {
  document_type: 'Tax invoice, invoice or credit note',
  labelled_iv: 'IV reference read from a labelled field (or a strong evidence placement, when allowed)',
  exact_match: 'Exactly one job carries the IV reference (or the delivery address is one job\'s site, when allowed)',
  job_active: 'The matched job is active',
  figures_printed: 'Ex-GST, GST and total all printed on the document',
  totals_consistent: 'Ex-GST + GST equals the total',
  invoice_number: 'Supplier invoice number present',
  invoice_date: 'Invoice date present and recent',
  not_duplicate: 'Not a duplicate',
  supplier_trusted: 'Supplier has a previously confirmed invoice',
  supplier_not_flagged: 'Supplier is not set to “always review”',
  under_cap: 'Ex-GST amount under the cap',
  credit_has_invoice: 'Credit note: supplier already has a confirmed invoice on this job',
  untouched: 'No person has edited or held it',
  not_paid_personally: 'Receipt: not paid with a worker\'s own money (those need a person to reimburse)',
};

function isPrinted(field) {
  return !!(field && (field.provenance === 'pdf_text' || field.provenance === 'ocr') && field.value != null);
}

/**
 * @param {object} inv the invoice row (store shape)
 * @param {{ capCents: number, lookbackDays: number, now?: Date,
 *           supplierHumanConfirmed: boolean, supplierAlwaysReview: boolean,
 *           supplierConfirmedOnJob: boolean, jobStatus: string|null }} ctx
 * @returns {{ eligible: boolean, checks: Array<{ code: string, label: string, ok: boolean, detail?: string }> }}
 */
function evaluateAutoConfirm(inv, ctx) {
  const now = ctx.now || new Date();
  const checks = [];
  const add = (code, ok, detail) => checks.push({ code, label: CHECK_LABELS[code], ok: !!ok, ...(detail ? { detail } : {}) });

  add('document_type', ALLOCATABLE_TYPES.has(inv.documentType), inv.documentType);
  const reason = inv.matchReason || {};
  // An evidence placement (no IV printed) may stand in for the IV checks only
  // when the owner allows it AND the evidence is strong (a delivery address).
  const evidenceOk = inv.matchStatus === 'inferred' && reason.source === 'evidence' && reason.strength === 'strong' && ctx.allowInferred === true && !!inv.matchedJobId;
  // A receipt from the field: the worker chose the job at the moment of work;
  // it stands in for the IV checks only when the owner allows receipts to book.
  const workerOk = inv.source === 'receipt' && inv.matchStatus === 'manual' && reason.source === 'worker' && ctx.allowReceipts === true && !!inv.matchedJobId;
  const standIn = evidenceOk ? 'evidence: delivery address' : workerOk ? 'job chosen by the worker' : null;
  add('labelled_iv', (inv.matchStatus === 'exact' && reason.source === 'labelled') || evidenceOk || workerOk, standIn || reason.label || reason.source || null);
  add('exact_match', (inv.matchStatus === 'exact' && !!inv.matchedJobId && Number(reason.matchCount) === 1) || evidenceOk || workerOk, standIn || undefined);
  add('job_active', (ctx.jobStatus || 'active') === 'active', ctx.jobStatus || 'active');
  const f = inv.fields || {};
  // A retail receipt prints the total and "GST included"; ex GST is their
  // difference (exact arithmetic on two printed figures, not a guess).
  const receiptFigures = inv.source === 'receipt' && isPrinted(f.gstCents) && isPrinted(f.totalCents) && f.subtotalCents && f.subtotalCents.provenance === 'derived';
  add('figures_printed', (isPrinted(f.subtotalCents) && isPrinted(f.gstCents) && isPrinted(f.totalCents)) || receiptFigures);
  add('totals_consistent', inv.totalsConsistent === true);
  add('invoice_number', typeof inv.supplierInvoiceNumber === 'string' && inv.supplierInvoiceNumber.trim().length > 0);
  let dateOk = false;
  let dateDetail;
  if (typeof inv.invoiceDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(inv.invoiceDate)) {
    const ageDays = (now.getTime() - new Date(inv.invoiceDate + 'T00:00:00Z').getTime()) / 86_400_000;
    dateOk = ageDays >= -1 && ageDays <= ctx.lookbackDays;
    dateDetail = `${inv.invoiceDate} (${Math.round(ageDays)}d old, limit ${ctx.lookbackDays}d)`;
  }
  add('invoice_date', dateOk, dateDetail);
  add('not_duplicate', inv.status !== 'duplicate' && !inv.duplicateOfId);
  add('supplier_trusted', !!ctx.supplierHumanConfirmed, inv.supplierName || null);
  add('supplier_not_flagged', !ctx.supplierAlwaysReview);
  const cents = inv.subtotalCents;
  add('under_cap', Number.isInteger(cents) && cents >= 0 && cents < ctx.capCents, `${cents} < ${ctx.capCents} cents`);
  if (inv.documentType === 'credit_note') add('credit_has_invoice', !!ctx.supplierConfirmedOnJob);
  add('untouched', !inv.reviewedAt && !inv.heldAt);
  if (inv.source === 'receipt') add('not_paid_personally', !inv.paidPersonally);

  return { eligible: checks.every((c) => c.ok), checks };
}

/** Grace-window deadline. Pure. */
function autoConfirmDeadline(graceHours, now = new Date()) {
  const h = Number(graceHours);
  const hours = Number.isFinite(h) ? Math.max(1, h) : 12;
  return new Date(now.getTime() + hours * 3_600_000).toISOString();
}

const AUD = (cents) => {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? '-' : ''}$${Math.floor(abs / 100).toLocaleString('en-AU')}.${String(abs % 100).padStart(2, '0')}`;
};

/**
 * The Monday digest — the office's whole oversight of the automatic booking.
 * Pure: takes the numbers the store gathered, returns subject/text/html.
 * Never includes attachment content; supplier / number / job / amount only
 * (the recipients are the accounts list, who see amounts anyway).
 */
function buildDigest(d) {
  const week = d.weekLabel || 'last week';
  const lines = [];
  const html = [];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const row = (i) => `${i.supplierName || 'Unknown supplier'} · ${i.supplierInvoiceNumber || '—'} · ${i.jobLabel || i.matchedJobId || '—'} · ${AUD(i.amountCents)}`;

  lines.push(`Supplier invoices — ${week}`);
  lines.push('');
  const setAside = d.setAsideCount ? ` · Set aside (dockets, confirmations, remittances): ${d.setAsideCount}` : '';
  lines.push(`Captured: ${d.capturedCount} · Booked automatically: ${d.autoBooked.length} · Booked by a person: ${d.humanBooked.length} · Waiting on you: ${d.pending.length} · Failed: ${d.failedCount}${setAside}`);
  html.push(`<p><b>Captured ${d.capturedCount}</b> · booked automatically ${d.autoBooked.length} · booked by a person ${d.humanBooked.length} · waiting on you ${d.pending.length} · failed ${d.failedCount}${esc(setAside)}</p>`);

  const section = (title, items, empty) => {
    lines.push('', title);
    html.push(`<h3 style="margin:16px 0 4px">${esc(title)}</h3>`);
    if (!items.length) { lines.push(`  ${empty}`); html.push(`<p>${esc(empty)}</p>`); return; }
    html.push('<ul>');
    for (const i of items) { lines.push(`  • ${row(i)}`); html.push(`<li>${esc(row(i))}${i.url ? ` — <a href="${esc(i.url)}">open</a>` : ''}</li>`); }
    html.push('</ul>');
  };
  section('Booked automatically (reverse any of these from the invoice page)', d.autoBooked, 'None.');
  section('Waiting on a person', d.pending, 'Nothing waiting.');
  if (d.bookingSoon && d.bookingSoon.length) section('Booking automatically soon (hold one to stop it)', d.bookingSoon, 'None.');

  const health = [];
  if (d.failedCount > 0) health.push(`${d.failedCount} document(s) could not be read — open the inbox → Failed.`);
  if (d.stuckCount > 0) health.push(`${d.stuckCount} document(s) have waited more than a day to be read — the processing sweep may be stopped.`);
  if (d.lastReceivedAt) {
    const days = Math.floor((Date.now() - new Date(d.lastReceivedAt).getTime()) / 86_400_000);
    if (days >= 14) health.push(`No supplier email has arrived for ${days} days — check the mailbox forwarding rule.`);
  } else if (d.everReceived === false) {
    health.push('No supplier email has ever arrived — the mailbox forwarding rule may not be set.');
  }
  lines.push('', health.length ? 'Health' : 'Health: all good.');
  html.push(`<h3 style="margin:16px 0 4px">Health</h3>`);
  if (health.length) { for (const h of health) { lines.push(`  ! ${h}`); } html.push(`<ul>${health.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>`); }
  else html.push('<p>All good.</p>');
  if (d.inboxUrl) { lines.push('', `Open the inbox: ${d.inboxUrl}`); html.push(`<p><a href="${esc(d.inboxUrl)}">Open the invoice inbox</a></p>`); }

  return {
    subject: `Supplier invoices — ${week}: ${d.autoBooked.length} booked automatically, ${d.pending.length} waiting on you${health.length ? ' — attention needed' : ''}`,
    text: lines.join('\n'),
    html: `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">${html.join('')}</div>`,
    attention: health.length > 0,
  };
}

module.exports = { evaluateAutoConfirm, autoConfirmDeadline, buildDigest, AUTO_ACTOR, CHECK_LABELS };
