'use strict';

// Statement check (owner direction 2026-09-23). A supplier statement lists
// the invoices the supplier thinks we owe. Comparing that list with what was
// captured catches the invoice that never arrived — the one nobody would
// otherwise notice until the supplier chased it. Pure functions; the pipeline
// supplies the captured list and stores the result on the statement row
// (matchReason.statement) for the review screen.
//
// Honesty: a listed line is "captured" only on an exact (whitespace/punctuation
// -insensitive) invoice-number match against THIS supplier's captured rows;
// anything else is reported as not captured, never guessed.

const { normaliseIvReference } = require('./iv-match');

const MAX_LINES = 300;
const MONEY_RE = /-?\$?\s?\d{1,3}(?:,\d{3})+\.\d{2}|-?\$?\s?\d+\.\d{2}/g;
const DATE_RE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9},?\s+\d{2,4})\b/;
// a lettered reference may be short (CN-45); a bare number needs four digits
const REF_RE = /(?<![A-Z0-9\-\/.])((?:[A-Z]{1,6}[-\/]?\d{2,12}|\d{4,12})(?:[-\/][A-Z0-9]{1,6})?)(?![A-Z0-9\-\/.]|,\d)/gi;
const SKIP_LINE = /\b(?:balance|total|sub\s*total|statement\s*(?:date|no|number|#)|account\s*(?:no|number|#)?\s*:|abn|acn|page\s*\d|amount\s*due|opening|closing|carried|brought|current|\d+\s*days|overdue|aged|ageing|aging|phone|fax|email|www\.|po\s*box|bill\s*to|customer|terms)\b/i;
const PAYMENT_LINE = /\b(?:payment|receipt|paid|thank\s*you|remittance|eft|bpay|transfer|direct\s*deposit)\b/i;
const CREDIT_LINE = /\b(?:credit|cr|adjustment|adj)\b/i;

/** Loose key for comparing invoice numbers across print styles. Pure. */
function looseNumberKey(v) {
  const s = String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s || null;
}

function moneyToCents(tok) {
  const neg = /^-/.test(tok.trim());
  const n = Number(tok.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) * (neg ? -1 : 1);
}

/**
 * Lines of a statement that look like invoice / credit entries:
 * a reference token + an amount (+ optionally a date). Pure.
 * @returns {Array<{ ref: string, key: string, kind: 'invoice'|'credit', date: string|null, amountCents: number|null, line: number }>}
 */
function extractStatementLines(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/).slice(0, 2000);
  for (let i = 0; i < lines.length && out.length < MAX_LINES; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const money = line.match(MONEY_RE);
    if (!money) continue;
    if (PAYMENT_LINE.test(line)) continue;
    const hasInvoiceWord = /\b(?:inv|invoice|tax\s*invoice|credit\s*note|cn)\b/i.test(line);
    if (SKIP_LINE.test(line) && !hasInvoiceWord) continue;
    const date = DATE_RE.exec(line);
    // strip dates and money before hunting for the reference token
    const stripped = line.replace(DATE_RE, ' ').replace(MONEY_RE, ' ');
    let ref = null;
    for (const m of stripped.matchAll(REF_RE)) {
      const tok = m[1];
      if (normaliseIvReference(tok)) continue; // an IV job code is never the invoice number
      if (/^\d{4}$/.test(tok) && Number(tok) >= 1900 && Number(tok) <= 2100) continue; // a bare year
      if (/^\d{1,2}$/.test(tok)) continue;
      ref = tok;
      break;
    }
    if (!ref) continue;
    const kind = CREDIT_LINE.test(line) || money.some((t) => /^-/.test(t.trim())) ? 'credit' : 'invoice';
    out.push({ ref, key: looseNumberKey(ref), kind, date: date ? date[1] : null, amountCents: moneyToCents(money[0]), line: i + 1 });
  }
  return out;
}

/**
 * @param {ReturnType<typeof extractStatementLines>} listed
 * @param {Array<{ id: string, supplierInvoiceNumber: string|null, status: string, documentType: string, totalCents: number|null }>} captured
 */
function reconcileStatement(listed, captured) {
  const byKey = new Map();
  for (const c of captured || []) {
    const k = looseNumberKey(c.supplierInvoiceNumber);
    if (k && !byKey.has(k)) byKey.set(k, c);
  }
  const matched = [];
  const missing = [];
  const seen = new Set();
  for (const l of listed) {
    if (!l.key || seen.has(l.key)) continue;
    seen.add(l.key);
    const c = byKey.get(l.key);
    if (c) matched.push({ ref: l.ref, invoiceId: c.id, status: c.status, documentType: c.documentType, amountCents: l.amountCents, capturedTotalCents: c.totalCents == null ? null : c.totalCents });
    else missing.push({ ref: l.ref, kind: l.kind, date: l.date, amountCents: l.amountCents });
  }
  return { listed: matched.length + missing.length, matched, missing, checkedAt: new Date().toISOString() };
}

module.exports = { extractStatementLines, reconcileStatement, looseNumberKey };
