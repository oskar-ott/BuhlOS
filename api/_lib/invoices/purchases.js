'use strict';

// Recent purchases on a job (owner pull 2026-10-04): "view recent purchases
// from wholesalers on the job easily and simply — only PMs and admins can view
// the total cost". One projection for every viewer; the MONEY is the only
// thing that differs, and it is added — never stripped after the fact — only
// when the caller is office tier. Fields are whitelisted, so a new column on
// the invoice or line rows can never leak to a crew phone by accident. Pure.
//
// What a crew member sees per purchase: date, supplier, their invoice number,
// who bought it, whether it was a return (credit note) or a receipt from the
// field, and each line's description + quantity (+ the measure, "300 m").

const { CATEGORY_LABELS } = require('./categories');
const { measureOf } = require('./measure');

/** How a purchase reads in site words. */
function purchaseKind(inv) {
  if (inv.documentType === 'credit_note') return 'return';
  if (inv.source === 'receipt') return 'receipt';
  return 'invoice';
}

/**
 * @param {{ invoices: object[], lines: object[], totalCount: number, totalCents: number|null }} raw
 *        store.jobRecentPurchases output
 * @param {{ withCost: boolean, awaitingCount?: number }} opts
 */
function buildJobPurchases(raw, { withCost, awaitingCount = 0 }) {
  const linesByInvoice = new Map();
  for (const l of (raw && raw.lines) || []) {
    const list = linesByInvoice.get(l.invoiceId) || [];
    const measure = measureOf(l.description, l.quantity, l.unit);
    list.push({
      description: l.description || '',
      quantity: l.quantity == null ? null : l.quantity,
      unit: l.unit || null,
      category: l.category || 'other',
      categoryLabel: CATEGORY_LABELS[l.category] || CATEGORY_LABELS.other || 'Other',
      measure: { amount: measure.amount, unit: measure.unit },
    });
    linesByInvoice.set(l.invoiceId, list);
  }
  const purchases = ((raw && raw.invoices) || []).map((inv) => {
    const lines = linesByInvoice.get(inv.invoiceId) || [];
    const p = {
      id: inv.invoiceId,
      date: inv.invoiceDate || (inv.confirmedAt ? String(inv.confirmedAt).slice(0, 10) : null),
      supplier: inv.supplierName || null,
      supplierInvoiceNumber: inv.supplierInvoiceNumber || null,
      boughtBy: inv.purchaser || null,
      kind: purchaseKind(inv),
      lines,
    };
    // Office tier only: the ex-GST amount booked to the job (a return is negative).
    if (withCost) p.amountCents = inv.amountCents == null ? null : inv.amountCents;
    return p;
  });
  const out = {
    purchases,
    totalCount: Number((raw && raw.totalCount) || 0),
    awaitingCount: Number(awaitingCount || 0),
    costVisible: Boolean(withCost),
  };
  if (withCost) out.totalCents = raw && raw.totalCents != null ? raw.totalCents : 0;
  return out;
}

module.exports = { buildJobPurchases, purchaseKind };
