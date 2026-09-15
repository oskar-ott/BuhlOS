'use strict';

// Supplier identity for duplicate detection. A supplier invoice number is only
// unique WITHIN a supplier, so the supplier must be identified consistently
// across printings: "L&H Group Pty Ltd", "L & H GROUP PTY. LTD." and "L&H
// Group" must all yield the same key. The key is for LOOKUP only — the printed
// name is stored verbatim beside it. An ABN (11 digits, checksum-validated) is
// the strongest identity Australian documents carry and is extracted when
// present.

const SUFFIX_TOKENS = new Set([
  'pty', 'ltd', 'limited', 'pl', 'p/l', 'inc', 'incorporated', 'co', 'company',
  'group', 'the', 'australia', 'aust', 'au', 'trading', 'as', 'ta', 't/a',
]);

/** Conservative lookup key for a supplier name, or null when nothing usable remains. Pure. */
function normaliseSupplierName(name) {
  if (name == null) return null;
  const tokens = String(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !SUFFIX_TOKENS.has(t));
  const key = tokens.join(' ').trim();
  return key || null;
}

const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];

/** ATO ABN checksum. Pure. */
function isValidAbn(digits) {
  if (!/^\d{11}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    const d = Number(digits[i]) - (i === 0 ? 1 : 0);
    sum += d * ABN_WEIGHTS[i];
  }
  return sum % 89 === 0;
}

/** First checksum-valid ABN printed after an "ABN" label, or null. Pure. */
function extractAbn(text) {
  const re = /\bA\.?B\.?N\.?\s*[:#]?\s*((?:\d[\s-]?){11})/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const digits = m[1].replace(/[\s-]/g, '');
    if (isValidAbn(digits)) return digits;
  }
  return null;
}

module.exports = { normaliseSupplierName, isValidAbn, extractAbn };
