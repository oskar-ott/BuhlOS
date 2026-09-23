'use strict';

// Explicit states for a captured supplier document (never ambiguous booleans).
//
//   received      durable receipt written; nothing extracted yet
//   processing    an attempt is running (or died mid-run — the sweep reclaims it)
//   matched       extraction ok + exactly one job matched — AWAITING CONFIRMATION
//   needs_review  extraction ok but a human must decide (no/ambiguous/multi
//                 reference, totals inconsistent, missing figures, unknown type…)
//   confirmed     an office user confirmed the job + cost; ONE active allocation
//   duplicate     the same document / supplier+number already exists
//   excluded      statement / quote / unrelated — never a cost
//   failed        extraction failed after retries (retryable)
//   archived      soft-archived (recoverable); a confirmed allocation is reversed
//
// A row never leaves the table; the event rows record every move.

const STATUSES = ['received', 'processing', 'matched', 'needs_review', 'confirmed', 'duplicate', 'excluded', 'failed', 'archived'];
const DOCUMENT_TYPES = ['invoice', 'tax_invoice', 'credit_note', 'statement', 'quote', 'delivery_docket', 'order_confirmation', 'remittance', 'purchase_order', 'other', 'unknown'];
// Paperwork wholesalers email that is NEVER a cost: set aside automatically
// (status excluded, reason not_an_invoice:<type>) — visible under Excluded,
// restorable if the reader got it wrong.
const NON_INVOICE_TYPES = new Set(['delivery_docket', 'order_confirmation', 'remittance', 'purchase_order', 'other']);
const MATCH_STATUSES = ['none', 'exact', 'ambiguous', 'not_found', 'multi_reference', 'manual'];
const ALLOCATABLE_TYPES = new Set(['invoice', 'tax_invoice', 'credit_note']);

// user-action transitions (the pipeline's own moves are separate)
const TRANSITIONS = {
  confirm: new Set(['matched', 'needs_review']),
  mark_duplicate: new Set(['matched', 'needs_review', 'failed']),
  exclude: new Set(['matched', 'needs_review', 'confirmed', 'failed', 'duplicate']),
  archive: new Set(['matched', 'needs_review', 'confirmed', 'duplicate', 'excluded', 'failed']),
  restore: new Set(['duplicate', 'excluded', 'archived']),
  retry: new Set(['failed', 'needs_review', 'matched', 'received', 'processing']),
  correct: new Set(['matched', 'needs_review', 'failed']),
  select_job: new Set(['matched', 'needs_review', 'failed']),
  reassign: new Set(['confirmed']),
};

/** True when `action` may run from `status`. Pure. */
function canTransition(status, action) {
  const allowed = TRANSITIONS[action];
  return !!(allowed && allowed.has(status));
}

/** Review reason codes → office wording (server copy, mirrored in the UI). */
const REVIEW_REASON_LABELS = {
  no_iv_reference: 'No IV job reference found on the document',
  iv_not_found: 'The IV job reference does not match any job',
  iv_ambiguous: 'More than one job carries this IV reference',
  multi_reference: 'Several different IV references appear on the document',
  totals_inconsistent: 'Ex-GST + GST does not equal the total',
  missing_subtotal: 'No ex-GST amount could be read',
  unknown_document_type: 'Could not tell what kind of document this is',
  not_allocatable: 'Statements and quotes are never job costs',
  statement_missing_invoices: 'Invoices on this statement were never captured — see the statement check',
  no_text_layer: 'The PDF has no readable text (scanned image) — enter the details by hand',
  job_inactive: 'The matched job is not active',
  extraction_failed: 'The document could not be read',
  negative_amounts: 'The amounts are negative — is this a credit note?',
  image_only: 'This is a photo or scan — enter the details by hand',
  no_attachment: 'The email had no PDF attached — open the link, download the invoice and attach it',
  forwarded_as_attachment: 'The email was forwarded as an attachment (.eml) — set the mailbox rule to forward normally, then attach the PDF',
  zip_attachment: 'The attachment was a zip — open it and attach the PDF',
  unsupported_attachment: 'The attachment type is not supported — attach the PDF',
  attachment_unreadable: 'The attachment could not be downloaded or read (too large, corrupt, or not really a PDF) — attach the invoice by hand',
};

module.exports = {
  STATUSES,
  DOCUMENT_TYPES,
  MATCH_STATUSES,
  ALLOCATABLE_TYPES,
  NON_INVOICE_TYPES,
  TRANSITIONS,
  canTransition,
  REVIEW_REASON_LABELS,
};
