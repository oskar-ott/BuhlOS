'use strict';

// Rule-based extraction of supplier-invoice fields from a PDF's TEXT LAYER.
//
// Honesty rules (P7): every value carries where it came from (the label it was
// read under and the line) and a confidence; nothing is guessed. A field that
// cannot be read is null — the office types it in review. Forwarded email
// subject/body text never enters this module; only the document does.
//
// This is deliberately a first, conservative parser: it recognises the label
// vocabulary Australian electrical wholesalers print (Job Number / Your
// Reference / Order No … for the IV job reference; Tax Invoice No / Invoice
// Number for the supplier's own number; Sub Total / GST / Total inc GST for the
// figures) and refuses to be clever. Real supplier samples are needed to widen
// it — see docs/invoice-capture.md "Samples still required".

const { parseMoneyToCents, reconcileTotals } = require('./money');
const { extractDeliveryAddress } = require('./placement');
const { extractIvCandidates, selectIvReference, normaliseIvReference } = require('./iv-match');
const { extractAbn } = require('./supplier-identity');

const EXCERPT_CHARS = 2000;

// ── document type ──────────────────────────────────────────────────────────
// Priority order. Credit notes, remittances, statements and quotes beat
// "invoice" words (a statement lists invoices; a remittance names them). An
// invoice word beats docket / confirmation / purchase-order words, because a
// wholesaler's "Tax Invoice / Delivery Docket" IS the invoice and every invoice
// prints "Purchase Order No: …" — so those types only win when no invoice word
// appears at all. Pro-forma invoices are requests for payment before supply,
// never a cost: "other".
const TYPE_RULES = [
  { type: 'credit_note', re: /\b(?:credit|adjustment)\s*note\b|\bcredit\s*memo\b/i },
  { type: 'remittance', re: /\b(?:remittance|payment)\s*advice\b/i },
  { type: 'statement', re: /\bstatement\b/i },
  { type: 'quote', re: /\bquot(?:e|ation)\b/i },
  { type: 'other', re: /\bpro[\s-]?forma\b/i },
  { type: 'tax_invoice', re: /\btax\s*invoice\b/i },
  { type: 'invoice', re: /\binvoice\b/i },
  { type: 'delivery_docket', re: /\bdelivery\s*(?:docket|note|advice)\b|\b(?:picking|packing)\s*(?:slip|list)\b|\bdespatch\s*(?:note|advice|docket)\b|\bdispatch\s*(?:note|advice|docket)\b/i },
  { type: 'order_confirmation', re: /\border\s*(?:confirmation|acknowledg(?:e)?ment)\b|\bsales\s*order\b|\bconfirmation\s*of\s*order\b/i },
  { type: 'purchase_order', re: /\bpurchase\s*order\b/i },
];

/** Classify by priority (see TYPE_RULES), looking at the document HEADER first
 *  (top 30% of lines, at least 12), then the whole text at lower confidence. Pure. */
function classifyDocumentType(lines) {
  const headerCount = Math.max(12, Math.ceil(lines.length * 0.3));
  const header = lines.slice(0, headerCount).join('\n');
  for (const rule of TYPE_RULES) {
    if (rule.re.test(header)) return { type: rule.type, confidence: 'high', region: 'header' };
  }
  const all = lines.join('\n');
  for (const rule of TYPE_RULES) {
    if (rule.re.test(all)) return { type: rule.type, confidence: 'low', region: 'body' };
  }
  return { type: 'unknown', confidence: 'none', region: null };
}

// ── supplier invoice number (the SUPPLIER's number — never the IV reference) ──
const INVOICE_NUMBER_RE =
  /\b(?:tax\s*invoice|invoice|inv|credit\s*note|adjustment\s*note|credit|document|doc|reference)\s*(?:no\.?|number|num|#|id)?\s*[:#]?\s*(?=[A-Z0-9\-\/]{0,29}\d)([A-Z0-9][A-Z0-9\-\/]{2,29})\b/i;
const DATE_WORD = /^(?:date|due|total|number|no|amount)$/i;

function extractSupplierInvoiceNumber(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = INVOICE_NUMBER_RE.exec(line);
    if (!m) continue;
    const value = m[1].trim();
    if (DATE_WORD.test(value)) continue;
    if (normaliseIvReference(value)) continue; // an IV code is never the invoice number
    if (/^\d{1,2}[\/\-.]\d{1,2}/.test(value)) continue; // a date fragment
    const label = m[0].slice(0, m[0].length - value.length).trim().replace(/[:#\s]+$/, '');
    return { value, label, line: i + 1, confidence: /credit|invoice|inv/i.test(label) ? 'high' : 'medium' };
  }
  // label on one line, value on the next
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^\s*(?:tax\s*invoice|invoice|credit\s*note)\s*(?:no\.?|number|#)\s*:?\s*$/i.test(lines[i])) {
      const v = /^\s*(?=[A-Z0-9\-\/]{0,29}\d)([A-Z0-9][A-Z0-9\-\/]{2,29})\s*$/i.exec(lines[i + 1]);
      if (v && !normaliseIvReference(v[1])) return { value: v[1], label: lines[i].trim(), line: i + 2, confidence: 'medium' };
    }
  }
  return null;
}

// ── dates (day-first, Australian) ──────────────────────────────────────────
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const DATE_TOKEN = /(\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9},?\s+\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/;

function toIsoDate(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const back = new Date(iso + 'T00:00:00Z');
  return Number.isNaN(back.getTime()) || back.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** Parse one printed date to YYYY-MM-DD (day-first for numeric forms). Pure. */
function parseDate(token) {
  const s = String(token || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return toIsoDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return toIsoDate(y, +m[2], +m[1]);
  }
  m = /^(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{2,4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 4).toLowerCase()] || MONTHS[m[2].slice(0, 3).toLowerCase()];
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return mon ? toIsoDate(y, mon, +m[1]) : null;
  }
  m = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 4).toLowerCase()] || MONTHS[m[1].slice(0, 3).toLowerCase()];
    return mon ? toIsoDate(+m[3], mon, +m[2]) : null;
  }
  return null;
}

const DATE_LABELS = [
  { re: /\b(?:tax\s*invoice|invoice|inv|credit(?:\s*note)?|document|doc|issue)\s*date\b|\bdate\s*of\s*issue\b|\bdate\s*issued\b/i, confidence: 'high' },
  { re: /^\s*date\s*[:#]?\s*/i, confidence: 'medium' },
];
const NOT_INVOICE_DATE = /\b(?:due|delivery|deliver|order|dispatch|despatch|payment|pay\s*by|period|statement)\s*date\b/i;

function extractInvoiceDate(lines) {
  for (const { re, confidence } of DATE_LABELS) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!re.test(line) || NOT_INVOICE_DATE.test(line)) continue;
      const after = line.slice(line.search(re));
      const dm = DATE_TOKEN.exec(after);
      const token = dm ? dm[1] : (DATE_TOKEN.exec(lines[i + 1] || '') || [])[1];
      const iso = token ? parseDate(token) : null;
      if (iso) return { value: iso, raw: token, line: i + 1, confidence };
    }
  }
  return null;
}

// ── money lines ────────────────────────────────────────────────────────────
const MONEY_AT_END = /(-?\(?\s*(?:AUD|A\$|\$)?\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})\s*\)?(?:\s*CR)?)\s*$/i;
const MONEY_ONLY = /^\s*(-?\(?\s*(?:AUD|A\$|\$)?\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})\s*\)?(?:\s*CR)?)\s*$/i;

function moneyOn(lines, i) {
  const m = MONEY_AT_END.exec(lines[i]);
  if (m) {
    const cents = parseMoneyToCents(m[1].replace(/\s+/g, ''));
    if (cents != null) return { cents, line: i + 1 };
  }
  const n = lines[i + 1] ? MONEY_ONLY.exec(lines[i + 1]) : null;
  if (n) {
    const cents = parseMoneyToCents(n[1].replace(/\s+/g, ''));
    if (cents != null) return { cents, line: i + 2 };
  }
  return null;
}

const TOTAL_RULES = {
  subtotal: [
    { re: /\bsub[\s-]?total\b/i, confidence: 'high' },
    { re: /\btotal\s*\(?\s*(?:ex|excl|excluding|exc)\.?\s*(?:of\s*)?gst\s*\)?/i, confidence: 'high' },
    { re: /\b(?:goods|net|taxable)\s*(?:value|amount|total)\b/i, confidence: 'high' },
    { re: /\b(?:amount|value|total)\s*(?:ex|excl|excluding)\.?\s*gst\b/i, confidence: 'high' },
    { re: /\b(?:ex|excl|excluding)\.?\s*gst\b/i, confidence: 'medium' },
  ],
  gst: [
    { re: /\b(?:total\s*|plus\s*|add\s*)?gst\s*(?:amount|@?\s*10\s*%|\(10%\)|payable|included|total)?\s*[:$]?\s*$/i, confidence: 'high', trailing: true },
    { re: /\bgst\b/i, confidence: 'medium' },
    { re: /^\s*(?:total\s*)?tax\s*[:$]/i, confidence: 'low' },
  ],
  total: [
    { re: /\btotal\s*\(?\s*(?:inc|incl|including)\.?\s*(?:of\s*)?gst\s*\)?/i, confidence: 'high' },
    { re: /\b(?:invoice|credit(?:\s*note)?|document|adjustment)\s*total\b/i, confidence: 'high' },
    { re: /\b(?:total|amount|balance)\s*(?:due|payable|owing)\b/i, confidence: 'high' },
    { re: /\btotal\s*amount\b/i, confidence: 'medium' },
    { re: /\b(?:grand\s*)?total\b/i, confidence: 'low', strict: true },
  ],
};
// a generic "Total" line must not be one of the other categories
const NOT_GENERIC_TOTAL = /\b(?:sub|gst|tax|ex|excl|net|goods|qty|quantity|items?|units?)\b/i;
// a GST line must carry an amount, not a registration number
const GST_NOISE = /\b(?:reg|registration|no\.?|number|abn|inc|incl|including|ex|excl|excluding|free|exempt|rate)\b/i;

function extractTotalField(lines, kind) {
  for (const rule of TOTAL_RULES[kind]) {
    let best = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const labelPart = line.replace(MONEY_AT_END, '');
      if (!rule.re.test(rule.trailing ? labelPart : line)) continue;
      if (rule.strict && NOT_GENERIC_TOTAL.test(labelPart)) continue;
      if (kind === 'gst' && GST_NOISE.test(labelPart) && !/\bgst\s*(?:amount|included|payable|total)\b/i.test(labelPart)) continue;
      if (kind === 'subtotal' && /\binc|incl|including\b/i.test(labelPart)) continue;
      const money = moneyOn(lines, i);
      if (!money) continue;
      best = { ...money, label: labelPart.trim().slice(0, 40), confidence: rule.confidence }; // last wins (summary block)
    }
    if (best) return best;
  }
  return null;
}

// ── supplier name ──────────────────────────────────────────────────────────
const SUPPLIER_HINT = /\b(?:pty|ltd|limited|group|electrical|supplies|supply|wholesale|wholesalers|trading|distributors?|industries|inc|co)\b/i;
const NOT_SUPPLIER = /\b(?:tax\s*invoice|invoice|credit\s*note|statement|quote|quotation|abn|acn|page|date|phone|fax|email|www\.|http|po\s*box|bill\s*to|ship\s*to|deliver\s*to|sold\s*to|customer|account)\b/i;

function extractSupplierName(lines) {
  const top = lines.slice(0, 12);
  for (let i = 0; i < top.length; i++) {
    const l = top[i].trim();
    if (l.length < 3 || l.length > 60 || NOT_SUPPLIER.test(l) || !/[A-Za-z]{2,}/.test(l)) continue;
    if (SUPPLIER_HINT.test(l) && !/\d{2,}/.test(l)) return { value: l, line: i + 1, confidence: 'medium' };
  }
  for (let i = 0; i < top.length; i++) {
    const l = top[i].trim();
    if (l.length < 3 || l.length > 60 || NOT_SUPPLIER.test(l) || !/[A-Za-z]{3,}/.test(l) || /\d{3,}/.test(l)) continue;
    return { value: l, line: i + 1, confidence: 'low' };
  }
  return null;
}

function field(v, provenance = 'pdf_text') {
  if (!v) return { value: null, confidence: 'none', provenance: null, label: null, line: null };
  return { value: v.value, confidence: v.confidence || 'medium', provenance, label: v.label || v.raw || null, line: v.line || null };
}

/**
 * Extract every field the pipeline needs from PDF text. Pure.
 * @param {string} text
 */
function extractInvoiceFromText(text) {
  const rawLines = String(text || '').split(/\r?\n/);
  const lines = rawLines.map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim().length > 0);

  const docType = classifyDocumentType(lines);
  const supplier = extractSupplierName(lines);
  const abn = extractAbn(lines.join('\n'));
  const invoiceNumber = extractSupplierInvoiceNumber(lines);
  const date = extractInvoiceDate(lines);
  const subtotal = extractTotalField(lines, 'subtotal');
  const gst = extractTotalField(lines, 'gst');
  const total = extractTotalField(lines, 'total');

  const negativeAmounts = [subtotal, gst, total].some((f) => f && f.cents < 0);
  const abs = (f) => (f ? Math.abs(f.cents) : null);
  const totals = reconcileTotals({ subtotalCents: abs(subtotal), gstCents: abs(gst), totalCents: abs(total) });

  const ivCandidates = extractIvCandidates(lines.join('\n'));
  const ivSelection = selectIvReference(ivCandidates);

  const fields = {
    documentType: { value: docType.type, confidence: docType.confidence, provenance: docType.type === 'unknown' ? null : 'pdf_text', label: docType.region, line: null },
    supplierName: field(supplier),
    supplierAbn: abn ? { value: abn, confidence: 'high', provenance: 'pdf_text', label: 'ABN', line: null } : field(null),
    supplierInvoiceNumber: field(invoiceNumber),
    invoiceDate: field(date),
    subtotalCents: subtotal ? { value: Math.abs(subtotal.cents), confidence: subtotal.confidence, provenance: 'pdf_text', label: subtotal.label, line: subtotal.line }
      : totals.derived.includes('subtotal') ? { value: totals.subtotalCents, confidence: 'medium', provenance: 'derived', label: 'total − GST', line: null } : field(null),
    gstCents: gst ? { value: Math.abs(gst.cents), confidence: gst.confidence, provenance: 'pdf_text', label: gst.label, line: gst.line }
      : totals.derived.includes('gst') ? { value: totals.gstCents, confidence: 'medium', provenance: 'derived', label: 'total − subtotal', line: null } : field(null),
    totalCents: total ? { value: Math.abs(total.cents), confidence: total.confidence, provenance: 'pdf_text', label: total.label, line: total.line }
      : totals.derived.includes('total') ? { value: totals.totalCents, confidence: 'medium', provenance: 'derived', label: 'subtotal + GST', line: null } : field(null),
    ivReference: ivSelection.outcome === 'selected'
      ? { value: ivSelection.normalised, confidence: ivSelection.source === 'labelled' ? 'high' : 'medium', provenance: 'pdf_text', label: ivSelection.label || (ivSelection.source === 'text' ? 'unlabelled token' : null), line: ivSelection.line }
      : field(null),
  };

  return {
    documentType: docType.type,
    supplierName: supplier ? supplier.value : null,
    supplierAbn: abn,
    supplierInvoiceNumber: invoiceNumber ? invoiceNumber.value : null,
    invoiceDate: date ? date.value : null,
    currency: 'AUD',
    subtotalCents: totals.subtotalCents,
    gstCents: totals.gstCents,
    totalCents: totals.totalCents,
    totalsConsistent: totals.consistent,
    totalsDerived: totals.derived,
    totalsDeltaCents: totals.deltaCents,
    negativeAmounts,
    ivCandidates,
    ivSelection,
    fields,
    excerpt: lines.join('\n').slice(0, EXCERPT_CHARS),
    // evidence for placement when no IV number is printed (placement.js)
    deliveryAddress: extractDeliveryAddress(lines),
    customerReferences: extractCustomerReferences(lines),
    placementText: lines.join('\n'),
  };
}

const REFERENCE_LABEL = /\b(?:your\s*(?:ref|reference|order)|customer\s*(?:ref|reference|order|po)|order\s*(?:ref|reference|no|number|#)|purchase\s*order|po\s*(?:no|number|#)?|reference|ref|attention|attn|project|site\s*name)\b\s*[:#\-]?\s*/i;
/** Free-text references a supplier prints back ("Your ref: Birdwood level 2"). Pure. */
function extractCustomerReferences(lines) {
  const out = [];
  for (const line of lines) {
    const m = REFERENCE_LABEL.exec(line);
    if (!m) continue;
    const v = line.slice(m.index + m[0].length).split(/\s{3,}/)[0].trim();
    if (v && v.length >= 3 && v.length <= 80 && !/^\d{1,2}[\/\-.]\d{1,2}/.test(v)) out.push(v);
    if (out.length >= 5) break;
  }
  return out;
}

module.exports = {
  extractInvoiceFromText,
  classifyDocumentType,
  extractSupplierInvoiceNumber,
  extractInvoiceDate,
  extractTotalField,
  extractSupplierName,
  parseDate,
};
