'use strict';

// Per-job materials SPEND ledger (owner pull 2026-08-23: "see all the
// materials being used on a job and the value of all of that").
//
// What it is: the office's record of what was BOUGHT for a job — one line per
// docket/invoice (date, supplier, what for, amount ex GST). It is the one real
// source the job hub's Materials figure has: the legacy materials-list tool
// that wrote jobs/<id>/materials-list.json was deleted in the 2026-07-27 gut,
// so that file exists for no job and the Money card read "—" forever.
//
// What it is NOT (deliberately): not the task-led "materials facet"
// (docs/architecture/task-led-job-architecture.md — what a task NEEDS, keyed
// by canonical task identity), not procurement (no orders, no receiving, no
// invoice match), not field capture (Phil's cognitive budget, P10 — a field
// path is a separate governance decision). Job-level commercial money, like
// contractValue; it carries no area/task linkage by design.
//
// Storage: blob `jobs/<jobId>/materials-ledger.json`
//   { lines: [ { id, date: 'YYYY-MM-DD', supplier, description|null, amountCents,
//                createdBy, createdByName, createdAt,
//                deletedAt?, deletedBy?, deletedByName? } ] }
//
// MONEY IS INTEGER CENTS (P7 — no invented precision; same discipline as the
// cost-rate store #304). $123.45 is 12345. Display layers divide by 100.
//
// Removal is a SOFT delete (tombstone on the line) so a removed docket is
// still attributable; totals and listings exclude tombstoned lines. No
// transactional storage: a blob read-modify-write like every other store.

const { readBlob, writeBlob } = require('./blob');
const { nanoid } = require('./validation');
const { normaliseSupplierName } = require('./invoices/supplier-identity');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_AMOUNT_CENTS = 100_000_000_00; // $100,000,000 — an obvious typo guard, not a policy
const MAX_LINES = 2000;
// Possible-duplicate check (2026-09-27): a typed docket vs the confirmed
// supplier invoices already booked on the job. Tunables are deliberate:
const REFERENCE_MAX = 60;           // a docket / supplier invoice number
const DUPLICATE_WINDOW_DAYS = 14;   // same supplier + same amount within this many days → possible
const REFERENCE_DIGITS_MIN = 4;     // trailing digit runs shorter than this only match exactly
const OVERRIDE_REASON_MIN = 3;
const OVERRIDE_REASON_MAX = 200;

/** True only for a real calendar date — JS Date silently rolls 2026-02-31 to
 *  3 March, so the round-trip must reproduce the input exactly. */
function isRealDate(date) {
  const d = new Date(date + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function keyFor(jobId) {
  return `jobs/${jobId}/materials-ledger.json`;
}

async function readLedger(jobId) {
  const data = await readBlob(keyFor(jobId), { lines: [] });
  return data && typeof data === 'object' && Array.isArray(data.lines) ? data : { lines: [] };
}

async function writeLedger(jobId, data) {
  await writeBlob(`jobs/${jobId}/materials-ledger.json`, { lines: (data && data.lines) || [] });
}

/** Non-deleted lines, newest date first (ties: newest created first). Pure. */
function activeLines(data) {
  const lines = (data && Array.isArray(data.lines) ? data.lines : []).filter(
    (l) => l && !l.deletedAt,
  );
  return lines.slice().sort((a, b) => {
    const d = String(b.date || '').localeCompare(String(a.date || ''));
    return d !== 0 ? d : String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

/** Sum of active line amounts, integer cents. Pure. */
function ledgerTotalCents(data) {
  let sum = 0;
  for (const l of activeLines(data)) {
    const c = Number(l.amountCents);
    if (Number.isInteger(c) && c > 0) sum += c;
  }
  return sum;
}

/** { lines, totalCents, count } — the read shape the API and the money read share. Pure. */
function summariseLedger(data) {
  const lines = activeLines(data);
  return { lines, totalCents: ledgerTotalCents({ lines }), count: lines.length };
}

/**
 * Validate an incoming line. Returns { ok, value } or { ok:false, error }.
 * date YYYY-MM-DD (a real calendar date); supplier 1–120 chars; description
 * optional ≤300 chars; amountCents a positive integer. Pure.
 */
function validateLineInput(body) {
  const b = body || {};
  const date = String(b.date || '').trim();
  if (!DATE_RE.test(date) || !isRealDate(date)) {
    return { ok: false, error: 'date must be a real YYYY-MM-DD date' };
  }
  const supplier = String(b.supplier || '').trim().slice(0, 120);
  if (!supplier) return { ok: false, error: 'supplier required' };
  const descriptionRaw = b.description == null ? '' : String(b.description).trim();
  if (descriptionRaw.length > 300) return { ok: false, error: 'description too long (300 max)' };
  const referenceRaw = b.reference == null ? '' : String(b.reference).trim();
  if (referenceRaw.length > REFERENCE_MAX) return { ok: false, error: `reference too long (${REFERENCE_MAX} max)` };
  const amountCents = Number(b.amountCents);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, error: 'amountCents must be a positive integer (cents)' };
  }
  if (amountCents > MAX_AMOUNT_CENTS) return { ok: false, error: 'amountCents implausibly large' };
  return {
    ok: true,
    value: { date, supplier, description: descriptionRaw || null, reference: referenceRaw || null, amountCents },
  };
}

/** Append a validated line; returns { data, line } (data is a copy). Pure. */
function appendLine(data, value, actor) {
  const lines = (data && Array.isArray(data.lines) ? data.lines : []).slice();
  if (lines.length >= MAX_LINES) {
    return { error: `ledger full (${MAX_LINES} lines) — archive this job's spend before adding more` };
  }
  const line = {
    id: nanoid('ml_'),
    date: value.date,
    supplier: value.supplier,
    description: value.description == null ? null : value.description,
    amountCents: value.amountCents,
    // Optional (2026-09-27): the docket / supplier invoice number, and the
    // audited override when the line was added despite a possible duplicate.
    ...(value.reference ? { reference: value.reference } : {}),
    ...(value.duplicateOverride ? { duplicateOverride: value.duplicateOverride } : {}),
    createdBy: (actor && actor.id) || '',
    createdByName: (actor && (actor.name || actor.username)) || '',
    createdAt: new Date().toISOString(),
  };
  lines.push(line);
  return { data: { lines }, line };
}

/** Soft-delete one line; returns { data, line } or null when absent/already removed. Pure. */
function removeLine(data, lineId, actor) {
  const lines = (data && Array.isArray(data.lines) ? data.lines : []).slice();
  const idx = lines.findIndex((l) => l && l.id === lineId && !l.deletedAt);
  if (idx < 0) return null;
  const line = {
    ...lines[idx],
    deletedAt: new Date().toISOString(),
    deletedBy: (actor && actor.id) || '',
    deletedByName: (actor && (actor.name || actor.username)) || '',
  };
  lines[idx] = line;
  return { data: { lines }, line };
}


// ── Possible duplicate cost ──────────────────────────────────────────────────
// A docket typed into this ledger that a CONFIRMED supplier invoice already
// books on the same job would count the cost twice in the Money card
// (api/job-profitability.js sums ledger + invoice allocations). The check is
// a warning with an audited override, never a silent block: equal amounts
// alone are never a duplicate; the supplier must match; a supplier invoice
// number match is the strongest signal; credit notes (negative) never match
// a positive docket; reversed/excluded documents are not passed in at all
// (store.jobActiveAllocations returns active, confirmed rows only).

/** "INV-00123" → "INV00123": upper-case, alphanumerics only. Pure. */
function normaliseReference(ref) {
  return String(ref == null ? '' : ref).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** The trailing run of digits with leading zeros dropped ("INV-00123" → "123"), or ''. Pure. */
function referenceDigits(ref) {
  const m = /(\d+)$/.exec(normaliseReference(ref));
  return m ? m[1].replace(/^0+/, '') : '';
}

/** Same reference: identical once normalised, or the same trailing number
 *  (≥ REFERENCE_DIGITS_MIN digits) — "INV-00123" ≙ "123", but "12" ≠ "INV-0012"
 *  unless typed identically. Pure. */
function referencesMatch(a, b) {
  const na = normaliseReference(a);
  const nb = normaliseReference(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const da = referenceDigits(a);
  const db = referenceDigits(b);
  return da.length >= REFERENCE_DIGITS_MIN && da === db;
}

/** The typed supplier and the invoice's supplier are the same business, by
 *  the invoice pipeline's own lookup key (suffixes/punctuation ignored). Pure. */
function supplierMatches(typedSupplier, allocation) {
  const key = normaliseSupplierName(typedSupplier);
  if (!key) return false;
  if (allocation.supplierKey && allocation.supplierKey === key) return true;
  const other = normaliseSupplierName(allocation.supplierName);
  return !!other && other === key;
}

function daysBetween(a, b) {
  const da = new Date(a + 'T00:00:00Z').getTime();
  const db = new Date(b + 'T00:00:00Z').getTime();
  if (!Number.isFinite(da) || !Number.isFinite(db)) return Infinity;
  return Math.abs(da - db) / 86400000;
}

/**
 * Confirmed allocations on the job that the typed line may duplicate,
 * strongest first. Each candidate names WHY so the office can judge it.
 *
 * @param {{ date: string, supplier: string, amountCents: number, reference?: string|null }} input
 * @param {Array<{ invoiceId: string, amountCents: number, confirmedAt: string|null, supplierName: string|null,
 *   supplierKey: string|null, supplierInvoiceNumber: string|null, invoiceDate: string|null, documentType: string|null }>} allocations
 * @param {{ windowDays?: number }} [opts]
 */
function findPossibleDuplicates(input, allocations, opts = {}) {
  const windowDays = Number.isFinite(opts.windowDays) ? opts.windowDays : DUPLICATE_WINDOW_DAYS;
  const out = [];
  for (const a of Array.isArray(allocations) ? allocations : []) {
    if (!a || !a.invoiceId) continue;
    // A credit note (negative) can never be the same cost as a positive docket.
    if (!Number.isInteger(a.amountCents) || a.amountCents <= 0 || a.documentType === 'credit_note') continue;
    if (!supplierMatches(input.supplier, a)) continue;
    const refMatch = !!(input.reference && a.supplierInvoiceNumber && referencesMatch(input.reference, a.supplierInvoiceNumber));
    const amountMatch = a.amountCents === input.amountCents;
    const dateRef = a.invoiceDate || (a.confirmedAt ? String(a.confirmedAt).slice(0, 10) : null);
    const dayGap = dateRef ? daysBetween(dateRef, input.date) : Infinity;
    const dateClose = dayGap <= windowDays;
    let strength = null;
    const reasons = ['same supplier'];
    if (refMatch) {
      strength = 'reference';
      reasons.push('same invoice number');
      reasons.push(amountMatch ? 'same amount' : 'different amount');
    } else if (amountMatch && dateClose) {
      strength = 'amount_date';
      reasons.push('same amount');
      reasons.push(dayGap === 0 ? 'same date' : `${Math.round(dayGap)} days apart`);
    }
    if (!strength) continue;
    out.push({
      invoiceId: a.invoiceId,
      strength,
      supplierName: a.supplierName || null,
      supplierInvoiceNumber: a.supplierInvoiceNumber || null,
      amountCents: a.amountCents,
      invoiceDate: a.invoiceDate || null,
      reasons,
    });
  }
  const rank = { reference: 0, amount_date: 1 };
  out.sort((x, y) => rank[x.strength] - rank[y.strength]);
  return out;
}

/** body.override → { reason } | null | { error }. A reason is mandatory. Pure. */
function parseOverride(body) {
  const o = body && body.override;
  if (o == null || o === false) return null;
  if (typeof o !== 'object') return { error: 'override must be an object { reason }' };
  const reason = String(o.reason == null ? '' : o.reason).trim();
  if (reason.length < OVERRIDE_REASON_MIN) return { error: 'override.reason required — say why this is not the confirmed invoice' };
  return { reason: reason.slice(0, OVERRIDE_REASON_MAX) };
}

module.exports = {
  normaliseReference,
  referencesMatch,
  supplierMatches,
  findPossibleDuplicates,
  parseOverride,
  DUPLICATE_WINDOW_DAYS,
  REFERENCE_MAX,
  keyFor,
  readLedger,
  writeLedger,
  activeLines,
  ledgerTotalCents,
  summariseLedger,
  validateLineInput,
  appendLine,
  removeLine,
  MAX_LINES,
};
