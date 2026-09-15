'use strict';

// Duplicate decisions — pure, so the three routes into the system (webhook,
// manual upload, provider retry) share ONE rule:
//
//   1. provider identity  (email id + attachment id)   → the store's unique
//      index refuses a second document row; the caller treats it as a no-op
//   2. content checksum   (sha256 of the PDF bytes)     → duplicate_of the
//      earliest invoice carrying that document
//   3. supplier + supplier invoice number (both known)  → duplicate_of the
//      earliest invoice with the same pair
//
// A supplier invoice number alone is NOT identity (two suppliers can both
// issue "1001"); a missing number never matches anything.

/**
 * @param {{ sha256?: string|null, supplierKey?: string|null, supplierInvoiceNumber?: string|null,
 *           byChecksum?: Array<{ id: string, status: string, createdAt?: string }>,
 *           bySupplierNumber?: Array<{ id: string, status: string, createdAt?: string }> }} input
 *           candidate lists exclude the invoice being decided
 * @returns {{ duplicate: false } | { duplicate: true, ofId: string, reason: 'checksum'|'supplier_invoice_number' }}
 */
function decideDuplicate(input) {
  const eligible = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => r && r.id && r.status !== 'duplicate');
  const earliest = (rows) => rows.slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))[0];
  if (input && input.sha256) {
    const rows = eligible(input.byChecksum);
    if (rows.length) return { duplicate: true, ofId: earliest(rows).id, reason: 'checksum' };
  }
  const key = input && input.supplierKey;
  const num = normaliseInvoiceNumber(input && input.supplierInvoiceNumber);
  if (key && num) {
    const rows = eligible(input.bySupplierNumber);
    if (rows.length) return { duplicate: true, ofId: earliest(rows).id, reason: 'supplier_invoice_number' };
  }
  return { duplicate: false };
}

/** Supplier invoice numbers compare case-insensitively, whitespace-insensitively. Pure. */
function normaliseInvoiceNumber(v) {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase().replace(/\s+/g, '');
  return s || null;
}

module.exports = { decideDuplicate, normaliseInvoiceNumber };
