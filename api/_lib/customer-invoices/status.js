'use strict';

// The one status a person sees on a stage-invoice row — derived, pure.
// BuhlOS's own `state` says where the SEND is; Xero's status says what the
// invoice IS. For anything sent, Xero wins (ADR rule 6).

const DISPLAY = Object.freeze({
  planned: 'planned',
  sending: 'sending',
  failed: 'failed',
  cancelled: 'cancelled',
  draft: 'draft_in_xero',
  awaiting: 'awaiting_payment',
  partPaid: 'part_paid',
  paid: 'paid',
  overdue: 'overdue',
  voided: 'voided',
  deleted: 'deleted_in_xero',
  // sent, but Xero has not been read yet (should not outlive the read-back)
  unknown: 'sent_unchecked',
});

/**
 * @param {{ state: string, xeroStatus?: string|null, xeroAmountPaidCents?: number|null,
 *           xeroAmountDueCents?: number|null, xeroDueDate?: string|null, dueDate?: string|null }} row
 * @param {string} today  YYYY-MM-DD in the office's timezone
 * @returns {string} one of DISPLAY's values
 */
function displayStatus(row, today) {
  if (!row) return DISPLAY.planned;
  if (row.state === 'planned') return DISPLAY.planned;
  if (row.state === 'sending') return DISPLAY.sending;
  if (row.state === 'failed') return DISPLAY.failed;
  if (row.state === 'cancelled') return DISPLAY.cancelled;
  const xs = String(row.xeroStatus || '');
  if (xs === 'DELETED') return DISPLAY.deleted;
  if (xs === 'VOIDED') return DISPLAY.voided;
  if (xs === 'PAID') return DISPLAY.paid;
  if (xs === 'DRAFT' || xs === 'SUBMITTED') return DISPLAY.draft;
  if (xs === 'AUTHORISED') {
    const due = Number.isInteger(row.xeroAmountDueCents) ? row.xeroAmountDueCents : null;
    const paid = Number.isInteger(row.xeroAmountPaidCents) ? row.xeroAmountPaidCents : 0;
    const dueDate = row.xeroDueDate || row.dueDate || null;
    if (due != null && due > 0 && dueDate && typeof today === 'string' && dueDate < today) return DISPLAY.overdue;
    if (paid > 0 && (due == null || due > 0)) return DISPLAY.partPaid;
    return DISPLAY.awaiting;
  }
  return DISPLAY.unknown;
}

module.exports = { DISPLAY, displayStatus };
