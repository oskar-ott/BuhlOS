'use strict';

// Workshop stock quantities — exact, never floating point.
//
// Every quantity is held as an INTEGER count of thousandths of the item's base
// unit ("milli"): 42 each = 42000, 12.5 m = 12500. The database column is a
// bigint; the API parses decimal STRINGS digit by digit (never Number(x) * 1000,
// which drifts), so the ledger can add and subtract forever without error.
//
// Each base unit fixes its own precision:
//   • indivisible units (each, length, bag, box, roll, pack) — whole numbers only
//   • metres — one decimal place (10 cm), the precision a cable count is made to
//
// A unit is a promise about what a number means. Changing an item's unit after
// it has movement history would silently reinterpret every old quantity, so the
// store refuses that edit (see store.updateItem); there is no conversion here
// between units except an explicit, user-confirmed PACK conversion (2 boxes of
// 10 each = 20 each), computed by packTotalMilli and shown before saving.

const MILLI = 1000;

/** The base units an item can be counted in. `decimals` is the finest step. */
const UNITS = Object.freeze({
  each: Object.freeze({ key: 'each', singular: 'each', plural: 'each', decimals: 0 }),
  metre: Object.freeze({ key: 'metre', singular: 'm', plural: 'm', decimals: 1 }),
  length: Object.freeze({ key: 'length', singular: 'length', plural: 'lengths', decimals: 0 }),
  bag: Object.freeze({ key: 'bag', singular: 'bag', plural: 'bags', decimals: 0 }),
  box: Object.freeze({ key: 'box', singular: 'box', plural: 'boxes', decimals: 0 }),
  roll: Object.freeze({ key: 'roll', singular: 'roll', plural: 'rolls', decimals: 0 }),
  pack: Object.freeze({ key: 'pack', singular: 'pack', plural: 'packs', decimals: 0 }),
});

const UNIT_KEYS = Object.freeze(Object.keys(UNITS));

/** What a pack (the thing a pack conversion counts) may be called. */
const PACK_UNITS = Object.freeze(['box', 'pack', 'bag', 'roll', 'length', 'carton', 'coil', 'reel']);

/** One movement can move at most this many base units (a typo guard, not a business rule). */
const MAX_MOVE_MILLI = 100000 * MILLI;
/** At most this many packs in one movement. */
const MAX_PACK_COUNT = 1000;

function isUnit(u) {
  return typeof u === 'string' && Object.prototype.hasOwnProperty.call(UNITS, u);
}

function stepMilli(unit) {
  const u = UNITS[unit];
  if (!u) throw new Error(`unknown unit ${unit}`);
  return MILLI / 10 ** u.decimals;
}

/**
 * Parse a decimal quantity string ("12", "12.5", "0.1") into milli for `unit`.
 * Pure. Returns { milli } or { error } with a stable code:
 *   quantity_required · quantity_invalid · quantity_too_precise · quantity_zero · quantity_too_large
 * Accepts a finite JS number too (converted through its shortest decimal string),
 * so callers that already hold a number cannot sneak floating error in.
 */
function parseQuantity(input, unit, { allowZero = false, max = MAX_MOVE_MILLI } = {}) {
  if (!isUnit(unit)) return { error: 'unit_invalid' };
  if (input === null || input === undefined || input === '') return { error: 'quantity_required' };
  let s;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { error: 'quantity_invalid' };
    s = String(input);
    if (/e/i.test(s)) return { error: 'quantity_invalid' };
  } else if (typeof input === 'string') {
    s = input.trim();
  } else {
    return { error: 'quantity_invalid' };
  }
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return { error: 'quantity_invalid' };
  const whole = m[1];
  const frac = (m[2] || '').replace(/0+$/, '');
  if (frac.length > UNITS[unit].decimals) return { error: 'quantity_too_precise', decimals: UNITS[unit].decimals };
  const milli = Number(whole) * MILLI + (frac ? Number(frac.padEnd(3, '0')) : 0);
  if (!Number.isSafeInteger(milli)) return { error: 'quantity_too_large' };
  if (milli === 0 && !allowZero) return { error: 'quantity_zero' };
  if (milli > max) return { error: 'quantity_too_large' };
  return { milli };
}

/** True when `milli` is a whole multiple of the unit's step (store-side re-check). */
function fitsUnit(milli, unit) {
  return Number.isSafeInteger(milli) && milli >= 0 && milli % stepMilli(unit) === 0;
}

/** "12.5", "42", "0.1" — the bare number, no trailing zeros. Pure. */
function formatNumber(milli) {
  const n = Number(milli);
  if (!Number.isSafeInteger(n)) return '?';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const whole = Math.floor(abs / MILLI);
  const frac = String(abs % MILLI).padStart(3, '0').replace(/0+$/, '');
  return sign + whole + (frac ? '.' + frac : '');
}

/** "42 each", "12.5 m", "1 box", "3 boxes". Pure. */
function formatQuantity(milli, unit) {
  const u = UNITS[unit];
  const num = formatNumber(milli);
  if (!u) return num;
  const label = Math.abs(Number(milli)) === MILLI ? u.singular : u.plural;
  return `${num} ${label}`;
}

/**
 * A confirmed pack conversion: `packCount` packs of `packSizeMilli` base units.
 * Returns { milli } or { error }. Integer maths only.
 */
function packTotalMilli(packCount, packSizeMilli, unit) {
  if (!Number.isInteger(packCount) || packCount < 1 || packCount > MAX_PACK_COUNT) return { error: 'pack_count_invalid' };
  if (!Number.isSafeInteger(packSizeMilli) || packSizeMilli <= 0 || !fitsUnit(packSizeMilli, unit)) return { error: 'pack_size_invalid' };
  const milli = packCount * packSizeMilli;
  if (!Number.isSafeInteger(milli) || milli > MAX_MOVE_MILLI) return { error: 'quantity_too_large' };
  return { milli };
}

/** Read a bigint-ish DB value ("42000" from postgres.js) as a safe integer. */
function toMilli(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  if (!Number.isSafeInteger(n)) throw new Error('quantity out of range');
  return n;
}

module.exports = {
  MILLI,
  UNITS,
  UNIT_KEYS,
  PACK_UNITS,
  MAX_MOVE_MILLI,
  MAX_PACK_COUNT,
  isUnit,
  stepMilli,
  parseQuantity,
  fitsUnit,
  formatNumber,
  formatQuantity,
  packTotalMilli,
  toMilli,
};
