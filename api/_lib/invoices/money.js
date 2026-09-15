'use strict';

// Supplier-invoice money helpers — INTEGER CENTS ONLY (P7; same discipline as
// api/_lib/job-materials.js and the cost-rate store). Nothing here stores or
// returns a float amount: parsing rounds a printed decimal to cents once, and
// every later operation is integer arithmetic.

const MAX_CENTS = 100_000_000_00; // $100,000,000 — typo guard, not a policy

/**
 * Parse a printed money string to integer cents. Accepts "$1,234.56",
 * "1234.56", "1,234", "AUD 12.00", "(12.00)" / "-12.00" / "12.00 CR" as
 * negative, and "12.5" (→ 1250). Returns null for anything ambiguous or empty
 * — a null is "unknown", never "0". Pure.
 * @param {unknown} input
 * @returns {number|null}
 */
function parseMoneyToCents(input) {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }
  if (/\bCR\b\s*$/i.test(s)) { negative = true; s = s.replace(/\bCR\b\s*$/i, '').trim(); }
  s = s.replace(/^(AUD|A\$|AU\$|\$)\s*/i, '').replace(/\s*(AUD)$/i, '').trim();
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1).trim(); }
  if (s.startsWith('$')) s = s.slice(1).trim();
  // digits with optional thousands separators and optional 1–2 decimals
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const whole = Number(m[1].replace(/,/g, ''));
  const frac = m[2] == null ? 0 : Number(m[2].length === 1 ? m[2] + '0' : m[2]);
  if (!Number.isFinite(whole) || !Number.isFinite(frac)) return null;
  const cents = whole * 100 + frac;
  if (cents > MAX_CENTS) return null;
  return negative ? -cents : cents;
}

/** True for a usable stored amount: a non-negative integer number of cents. */
function isCents(v) {
  return Number.isInteger(v) && v >= 0 && v <= MAX_CENTS;
}

/**
 * Reconcile the three printed figures. Integer cents in, integer cents out.
 *
 *   all three present → consistent iff |subtotal + gst − total| ≤ 1 cent
 *   two present       → the third is DERIVED by exact arithmetic (labelled so
 *                       the reviewer sees it) — the only derivation allowed;
 *                       GST is never assumed to be 10%
 *   fewer             → consistent: null (unknown), nothing derived
 *
 * A derived negative figure is impossible on a real document and is reported
 * as inconsistent rather than clamped. Pure.
 *
 * @param {{ subtotalCents?: number|null, gstCents?: number|null, totalCents?: number|null }} input
 * @returns {{ subtotalCents: number|null, gstCents: number|null, totalCents: number|null,
 *             consistent: boolean|null, derived: string[], deltaCents: number|null }}
 */
function reconcileTotals(input) {
  const sub = isCents(input && input.subtotalCents) ? input.subtotalCents : null;
  const gst = isCents(input && input.gstCents) ? input.gstCents : null;
  const tot = isCents(input && input.totalCents) ? input.totalCents : null;
  const derived = [];
  if (sub != null && gst != null && tot != null) {
    const delta = sub + gst - tot;
    return { subtotalCents: sub, gstCents: gst, totalCents: tot, consistent: Math.abs(delta) <= 1, derived, deltaCents: delta };
  }
  if (sub != null && tot != null) {
    const g = tot - sub;
    if (g < 0) return { subtotalCents: sub, gstCents: null, totalCents: tot, consistent: false, derived, deltaCents: g };
    derived.push('gst');
    return { subtotalCents: sub, gstCents: g, totalCents: tot, consistent: true, derived, deltaCents: 0 };
  }
  if (sub != null && gst != null) {
    derived.push('total');
    return { subtotalCents: sub, gstCents: gst, totalCents: sub + gst, consistent: true, derived, deltaCents: 0 };
  }
  if (gst != null && tot != null) {
    const s = tot - gst;
    if (s < 0) return { subtotalCents: null, gstCents: gst, totalCents: tot, consistent: false, derived, deltaCents: s };
    derived.push('subtotal');
    return { subtotalCents: s, gstCents: gst, totalCents: tot, consistent: true, derived, deltaCents: 0 };
  }
  return { subtotalCents: sub, gstCents: gst, totalCents: tot, consistent: null, derived, deltaCents: null };
}

/**
 * The sign a confirmed document contributes to job cost: an invoice / tax
 * invoice is +1, a credit note −1, everything else (statement, quote, unknown)
 * 0 = NOT allocatable. Pure.
 */
function allocationSignFor(documentType) {
  if (documentType === 'invoice' || documentType === 'tax_invoice') return 1;
  if (documentType === 'credit_note') return -1;
  return 0;
}

/**
 * The signed allocation for a document, or null when it must not be allocated
 * (non-allocatable type, or no reliable ex-GST subtotal). Pure.
 */
function allocationAmountCents(documentType, subtotalCents) {
  const sign = allocationSignFor(documentType);
  if (sign === 0) return null;
  if (!isCents(subtotalCents)) return null;
  return sign * subtotalCents;
}

module.exports = { parseMoneyToCents, isCents, reconcileTotals, allocationSignFor, allocationAmountCents, MAX_CENTS };
