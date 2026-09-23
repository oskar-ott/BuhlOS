'use strict';

// "Exactly how much cable" (owner pull 2026-09-24). A line says "3 roll" of
// "2.5MM TPS 100M ROLL": the useful number is 300 m. This turns a line's
// quantity + unit + description into a MEASURE — metres for lengths, pieces
// for packs, else the printed quantity in its unit — with the working shown,
// so a roll-up can add the same kind of thing together honestly. Pure.
//
// Never guesses: a pack size or length is taken only from an explicit token
// in the description (100M, 100 MTR, PK100, PKT OF 50, BOX 50, X100); when
// there is none the measure is just the quantity in its own unit.

const LENGTH_TOKEN = /(?<![\d.])(\d{1,5}(?:\.\d{1,2})?)\s*(?:m|mtr|mtrs|metre|metres|meter|meters)\b(?!\s*m\b)/i;
const LENGTH_UNITS = new Set(['m', 'mtr', 'mtrs', 'metre', 'metres', 'meter', 'meters']);
const PACK_TOKEN = /\b(?:pk|pkt|pack|packet|box|bx|ctn|carton|bag)\s*(?:of\s*)?(\d{1,5})\b|\b(\d{1,5})\s*(?:pk|pkt|pack|pce|pcs|pieces?)\b|(?<![\dA-Za-z])x\s?(\d{2,5})\b(?!\s*(?:mm|m\b))/i;
const COUNT_UNITS = new Set(['ea', 'each', 'pcs', 'pc', 'pce', 'unit', 'units', 'pr', 'pair', 'set', 'len', 'length', 'lengths', 'tube']);
const BUNDLE_UNITS = new Set(['roll', 'rl', 'rolls', 'drum', 'reel', 'coil', 'pk', 'pkt', 'pack', 'box', 'bx', 'ctn', 'carton', 'bag']);

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * @param {string} description
 * @param {number|null} quantity
 * @param {string|null} unit  as printed, lower-case (ea, m, roll, pk …)
 * @returns {{ amount: number|null, unit: 'm'|'pcs'|string|null, explain: string|null }}
 */
function measureOf(description, quantity, unit) {
  const d = String(description || '');
  const u = unit ? String(unit).toLowerCase().replace(/\.$/, '') : null;
  if (quantity == null || !Number.isFinite(quantity)) return { amount: null, unit: null, explain: null };
  // sold by the metre
  if (u && LENGTH_UNITS.has(u)) return { amount: round3(quantity), unit: 'm', explain: null };
  // a bundle (roll/drum/pack/box …) — or a count of things whose description carries a length
  const len = LENGTH_TOKEN.exec(d);
  if (len && (u == null || BUNDLE_UNITS.has(u) || COUNT_UNITS.has(u))) {
    const per = Number(len[1]);
    if (per > 0) return { amount: round3(quantity * per), unit: 'm', explain: `${round3(quantity)} × ${per} m` };
  }
  const pk = PACK_TOKEN.exec(d);
  if (pk && (u == null || BUNDLE_UNITS.has(u) || COUNT_UNITS.has(u))) {
    const per = Number(pk[1] || pk[2] || pk[3]);
    if (per > 1) return { amount: round3(quantity * per), unit: 'pcs', explain: `${round3(quantity)} × ${per}` };
  }
  if (u && COUNT_UNITS.has(u)) return { amount: round3(quantity), unit: 'pcs', explain: null };
  return { amount: round3(quantity), unit: u || 'pcs', explain: null };
}

/**
 * Roll a category's lines up by product (same supplier + description key):
 * total cost, printed quantities by unit, measure by measure-unit, invoices.
 * Pure; lines carry signedCents (credit notes negative) and a measure.
 */
function rollUpProducts(lines) {
  const byKey = new Map();
  for (const l of lines) {
    const key = `${l.supplierName || ''}::${l.descriptionKey || l.description}`;
    let p = byKey.get(key);
    if (!p) {
      p = { key, description: l.description, supplierName: l.supplierName || null, cents: 0, lineCount: 0, invoiceIds: new Set(), quantities: {}, measures: {}, lines: [] };
      byKey.set(key, p);
    }
    const sign = l.signedCents < 0 ? -1 : 1;
    p.cents += l.signedCents || 0;
    p.lineCount += 1;
    p.invoiceIds.add(l.invoiceId);
    if (l.quantity != null) { const qu = l.unit || 'ea'; p.quantities[qu] = round3((p.quantities[qu] || 0) + l.quantity * sign); }
    if (l.measure && l.measure.amount != null) { const mu = l.measure.unit; p.measures[mu] = round3((p.measures[mu] || 0) + l.measure.amount * sign); }
    p.lines.push(l);
  }
  return Array.from(byKey.values())
    .map((p) => ({ ...p, invoiceCount: p.invoiceIds.size, invoiceIds: undefined }))
    .sort((a, b) => b.cents - a.cents);
}

/** Category-level measure totals: only when every measured line agrees on the unit. */
function measureTotals(lines) {
  const totals = {};
  let measured = 0;
  for (const l of lines) {
    if (!l.measure || l.measure.amount == null) continue;
    measured += 1;
    const sign = l.signedCents < 0 ? -1 : 1;
    totals[l.measure.unit] = round3((totals[l.measure.unit] || 0) + l.measure.amount * sign);
  }
  return { totals, measuredLines: measured, unmeasuredLines: lines.length - measured };
}

module.exports = { measureOf, rollUpProducts, measureTotals };
