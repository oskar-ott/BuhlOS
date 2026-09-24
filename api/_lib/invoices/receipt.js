'use strict';

// Photo → pipeline shape (owner pull 2026-09-25). Pure. Turns the vision
// reader's JSON (vision-extract.js) into the same `extracted` object the text
// parser produces, so a photographed receipt flows through the one pipeline:
// duplicate rule, job placement, line filing, status, auto-booking.
//
// Retail receipts print GST-INCLUSIVE prices and a "GST included" figure; the
// job is costed ex GST. So the ex-GST figure is total − GST (both printed), and
// the line totals are scaled into ex-GST in proportion, with the rounding cent
// put on the largest line so the lines add up to the ex-GST figure exactly —
// only when the printed lines add up to the printed total in the first place.

const { reconcileTotals } = require('./money');
const { normaliseIvReference } = require('./iv-match');

const TYPE_MAP = { receipt: 'tax_invoice', tax_invoice: 'tax_invoice', invoice: 'invoice', credit_note: 'credit_note', delivery_docket: 'delivery_docket', other: 'other' };

function f(value, label = 'read from photo', confidence = 'medium') {
  return value == null ? { value: null, confidence: 'none', provenance: null, label: null, line: null } : { value, confidence, provenance: 'ocr', label, line: null };
}

/** @returns {object} the extractInvoiceFromText-compatible shape */
function extractedFromVision(v) {
  const totals = reconcileTotals({ subtotalCents: v.subtotalExGstCents, gstCents: v.gstCents, totalCents: v.totalCents });
  const derivedSub = v.subtotalExGstCents == null && totals.subtotalCents != null;
  const iv = v.ivReference ? normaliseIvReference(v.ivReference) : null;
  const documentType = TYPE_MAP[v.documentType] || 'unknown';
  const text = [v.storeName, v.receiptNumber, v.deliveryAddress, ...v.lines.map((l) => l.description)].filter(Boolean).join('\n');
  return {
    documentType,
    supplierName: v.storeName,
    supplierAbn: v.abn,
    supplierInvoiceNumber: v.receiptNumber,
    invoiceDate: v.date,
    currency: 'AUD',
    subtotalCents: totals.subtotalCents,
    gstCents: totals.gstCents,
    totalCents: totals.totalCents,
    totalsConsistent: totals.consistent,
    totalsDerived: totals.derived,
    totalsDeltaCents: totals.deltaCents,
    negativeAmounts: false,
    ivCandidates: iv ? [{ raw: v.ivReference, normalised: iv, source: 'ocr', label: 'read from photo', line: null }] : [],
    ivSelection: iv
      ? { outcome: 'selected', raw: v.ivReference, normalised: iv, source: 'ocr', label: 'read from photo', line: null }
      : { outcome: 'none' },
    fields: {
      documentType: f(documentType, 'read from photo'),
      supplierName: f(v.storeName),
      supplierAbn: f(v.abn, 'ABN'),
      supplierInvoiceNumber: f(v.receiptNumber),
      invoiceDate: f(v.date),
      subtotalCents: derivedSub ? { value: totals.subtotalCents, confidence: 'medium', provenance: 'derived', label: 'total − GST', line: null } : f(totals.subtotalCents),
      gstCents: f(totals.gstCents),
      totalCents: f(totals.totalCents),
      ivReference: f(iv),
    },
    excerpt: text.slice(0, 1500),
    deliveryAddress: v.deliveryAddress,
    customerReferences: [],
    placementText: text,
  };
}

/**
 * Lines in ex-GST cents. Returns the same { lines, totalCents, consistent,
 * reason } shape as extractLineItems. Pure.
 */
function linesFromVision(v, extracted) {
  const raw = v.lines.map((l, i) => ({ lineNo: i + 1, description: l.description, quantity: l.quantity, unit: l.unit, unitPriceCents: l.unitPriceCents, lineTotalCents: l.lineTotalCents, confidence: 'medium' }));
  if (!raw.length) return { lines: [], totalCents: 0, consistent: null, reason: 'no_lines_read' };
  const sub = extracted.subtotalCents;
  const tot = extracted.totalCents;
  const printed = raw.reduce((s, l) => s + (l.lineTotalCents || 0), 0);
  const tol = (n) => Math.max(5, raw.length, Math.round(Math.abs(n || 0) * 0.005));
  let lines = raw;
  if (v.pricesIncludeGst && sub != null && tot != null && tot !== 0 && Math.abs(printed - tot) <= tol(tot)) {
    lines = raw.map((l) => ({
      ...l,
      lineTotalCents: l.lineTotalCents == null ? null : Math.round((l.lineTotalCents * sub) / tot),
      unitPriceCents: l.unitPriceCents == null ? null : Math.round((l.unitPriceCents * sub) / tot),
    }));
    const residue = sub - lines.reduce((s, l) => s + (l.lineTotalCents || 0), 0);
    if (residue !== 0) {
      let big = 0;
      lines.forEach((l, i) => { if (Math.abs(l.lineTotalCents || 0) > Math.abs(lines[big].lineTotalCents || 0)) big = i; });
      lines[big] = { ...lines[big], lineTotalCents: (lines[big].lineTotalCents || 0) + residue };
    }
  }
  const totalCents = lines.reduce((s, l) => s + (l.lineTotalCents || 0), 0);
  if (sub == null) return { lines, totalCents, consistent: null, reason: null };
  if (Math.abs(totalCents - sub) <= tol(sub)) return { lines, totalCents, consistent: true, reason: null };
  if (tot != null && Math.abs(totalCents - tot) <= tol(tot)) return { lines, totalCents, consistent: false, reason: 'lines_include_gst' };
  return { lines, totalCents, consistent: false, reason: 'lines_do_not_add_up' };
}

module.exports = { extractedFromVision, linesFromVision };
