'use strict';

// Product identifiers for workshop stock — manufacturer codes, supplier SKUs and
// barcodes. Pure.
//
// The rules that keep two different products from being merged:
//   • A manufacturer code and a supplier SKU are DIFFERENT identifiers. They are
//     stored, matched and labelled separately; a hit on one is never reported
//     as a hit on the other.
//   • A code's punctuation and leading zeroes are part of the code. The exact
//     key only uppercases and drops whitespace ("2025 we" → "2025WE"); it never
//     drops "-", "/" or "." and never strips zeroes. "2025-WE" vs "2025WE" is
//     a punctuation-only difference — reported as "possible", never as exact —
//     and "C2025WE" is a different product from "2025WE" altogether.
//   • A barcode is digits with a valid GS1 check digit, or it is nothing. A
//     mis-read barcode that fails the check digit is dropped rather than risk
//     matching someone else's product. GTIN-8/12/13/14 compare on their
//     14-digit form (the standard GTIN padding — leading zeroes are kept).
//
// Text read from a photo or a web page is untrusted: anything outside the
// printable code alphabet is refused, not "cleaned up".

const crypto = require('crypto');

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9 ./_+#()-]{0,47}$/;
const MAX_CODE = 48;

/** Collapse whitespace; null for empty. */
function squash(v, max) {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}

/**
 * A printable product/catalogue code as written, or null when it isn't one.
 * A code is at most three space-separated parts, and one without a digit must
 * be a single short token — so a sentence ("ignore previous instructions …")
 * read off a label or a page can never pass as a code.
 */
function cleanCode(v) {
  const s = squash(v);
  if (!s || s.length < 2 || s.length > MAX_CODE) return null;
  if (!CODE_RE.test(s)) return null;
  if (s.replace(/[^A-Za-z0-9]/g, '').length < 2) return null;
  const parts = s.split(' ');
  if (parts.length > 3) return null;
  if (!/\d/.test(s) && (parts.length > 1 || s.length > 16)) return null;
  return s;
}

/** Exact comparison key: uppercase, whitespace removed. Punctuation + zeroes kept. */
function codeKey(code) {
  const s = cleanCode(code);
  return s ? s.toUpperCase().replace(/\s+/g, '') : null;
}

/** Loose key for "differs only in punctuation" — candidates only, never exact. */
function looseCodeKey(code) {
  const k = codeKey(code);
  if (!k) return null;
  const loose = k.replace(/[-./_+#()]/g, '');
  return loose.length >= 2 ? loose : null;
}

/**
 * A code too weak to stand on its own as evidence (pure digits under 5, or under
 * 4 characters at all): "2025" is a range, "10" is a rating. Such a code can
 * still be recorded, but it never makes a "manufacturer code matched" verdict.
 */
function isWeakCode(code) {
  const k = codeKey(code);
  if (!k) return true;
  const alnum = k.replace(/[^A-Z0-9]/g, '');
  if (alnum.length < 4) return true;
  if (/^\d+$/.test(alnum) && alnum.length < 5) return true;
  return false;
}

// ── barcodes ──────────────────────────────────────────────────────────────────

/** GS1 mod-10 check digit over the full digit string (last digit is the check). */
function gs1CheckOk(digits) {
  let sum = 0;
  const body = digits.slice(0, -1);
  for (let i = 0; i < body.length; i++) {
    const d = body.charCodeAt(body.length - 1 - i) - 48;
    sum += i % 2 === 0 ? d * 3 : d;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === digits.charCodeAt(digits.length - 1) - 48;
}

/** A GTIN-8/12/13/14 as read (digits kept as printed), or null. */
function cleanBarcode(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const raw = String(v).replace(/[\s-]/g, '');
  if (!/^\d+$/.test(raw)) return null;
  if (![8, 12, 13, 14].includes(raw.length)) return null;
  if (/^0+$/.test(raw)) return null;
  return gs1CheckOk(raw) ? raw : null;
}

/** Comparison key: the 14-digit GTIN form (left-padded with zeroes). */
function barcodeKey(v) {
  const b = cleanBarcode(v);
  return b ? b.padStart(14, '0') : null;
}

// ── brands + suppliers ────────────────────────────────────────────────────────

// Brand spellings that name the same maker. Deliberately short: a brand that is
// not listed compares on its own normalised spelling. HPM and Legrand stay
// separate keys (Legrand owns HPM, but they are separately catalogued ranges).
const BRAND_ALIASES = Object.freeze({
  'clipsal by schneider electric': 'clipsal',
  'clipsal by schneider': 'clipsal',
  'schneider electric': 'schneider',
  'schneider': 'schneider',
  'hpm legrand': 'hpm',
  'hpm by legrand': 'hpm',
  'nhp electrical engineering products': 'nhp',
  'abb australia': 'abb',
  'hager australia': 'hager',
});

/** Lowercase, letters/digits/spaces only, aliases folded. Null when empty. */
function brandKey(v) {
  const s = squash(v, 80);
  if (!s) return null;
  let k = s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  k = k.replace(/\b(pty|ltd|limited|inc|australia)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!k) return null;
  return BRAND_ALIASES[k] || k;
}

/** Supplier names compare the same way brands do (their own alias list is empty). */
function supplierKey(v) {
  const s = squash(v, 80);
  if (!s) return null;
  const k = s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(pty|ltd|limited|electrical|wholesale|wholesalers|supplies)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return k || null;
}

// ── identifier rows ───────────────────────────────────────────────────────────

const IDENTIFIER_KINDS = Object.freeze(['manufacturer_code', 'supplier_sku', 'barcode']);

/**
 * Normalise one identifier for storage + uniqueness. `scope` narrows where the
 * value is unique: a manufacturer code is unique within its brand, a supplier
 * SKU within its supplier, a barcode everywhere. Returns
 * { kind, value, valueKey, scope } or { error }.
 */
function identifierFor(kind, value, { brand = null, supplier = null } = {}) {
  if (!IDENTIFIER_KINDS.includes(kind)) return { error: 'identifier_kind_invalid' };
  if (kind === 'barcode') {
    const b = cleanBarcode(value);
    if (!b) return { error: 'barcode_invalid' };
    return { kind, value: b, valueKey: barcodeKey(b), scope: '' };
  }
  const code = cleanCode(value);
  if (!code) return { error: 'code_invalid' };
  const scope = kind === 'manufacturer_code' ? brandKey(brand) || '' : supplierKey(supplier) || '';
  return { kind, value: code, valueKey: codeKey(code), scope };
}

// ── online check: what was asked, and whether it still applies ───────────────

/** Size/rating words as the online check compares them: ≤ 8 words of ≤ 30 characters. */
function variantDetailsFrom(v) {
  const text = Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(' ') : typeof v === 'string' ? v : '';
  return text.split(/\s+/).filter(Boolean).slice(0, 8).map((w) => w.slice(0, 30));
}

function colourKey(v) {
  return (squash(v, 40) || '').toLowerCase();
}

function variantWordsKey(v) {
  return variantDetailsFrom(v).map((w) => w.toLowerCase()).sort().join(' ');
}

/**
 * The cache key of an online check: exactly what was asked — brand, code AND
 * the colour / size details it compared (a check for the white one is not a
 * check for the black one). Null when there is no usable code.
 */
function lookupKey({ brand = null, manufacturerCode = null, colourFinish = null, variantDetails = null } = {}) {
  const ck = codeKey(manufacturerCode);
  if (!ck) return null;
  const colour = colourKey(colourFinish);
  const words = variantWordsKey(variantDetails);
  const variantKey = colour || words ? crypto.createHash('sha256').update(JSON.stringify([colour, words])).digest('hex').slice(0, 32) : '';
  return { brandKey: brandKey(brand) || '', codeKey: ck, variantKey };
}

/**
 * Does an online check made for `check` (what was asked) still describe the item
 * being saved? The code must be the same. The brand and colour must be what was
 * checked — or, where the check had none, what the listing itself shows (that is
 * how accepting the listing fills them). The size/rating words must be the
 * ones checked. Anything else means the check was for a different item.
 * Mirrored for the screen in src/domains/workshop-stock/check.ts.
 */
function checkApplies(check, candidate, item) {
  if (!check || !item) return false;
  const ck = codeKey(check.manufacturerCode);
  if (!ck || ck !== codeKey(item.manufacturerCode)) return false;
  const c = candidate || {};
  const sameOrFromListing = (checked, saved, listed, key) => {
    const a = key(checked);
    const b = key(saved);
    return a === b || (!a && Boolean(b) && b === key(listed));
  };
  if (!sameOrFromListing(check.brand, item.brand, c.brand, (v) => brandKey(v) || '')) return false;
  if (!sameOrFromListing(check.colourFinish, item.colourFinish, c.colour, colourKey)) return false;
  return variantWordsKey(check.variantDetails) === variantWordsKey(item.variant);
}

module.exports = {
  MAX_CODE,
  IDENTIFIER_KINDS,
  squash,
  cleanCode,
  codeKey,
  looseCodeKey,
  isWeakCode,
  gs1CheckOk,
  cleanBarcode,
  barcodeKey,
  brandKey,
  supplierKey,
  identifierFor,
  variantDetailsFrom,
  lookupKey,
  checkApplies,
};
