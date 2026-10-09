'use strict';

// Workshop catalogue matching — "which of OUR items is this?". Pure.
//
// Order of evidence, strongest first:
//   1. barcode            exact GTIN (check digit valid)
//   2. manufacturer code  exact code key, same brand (or brand unread and the
//                         code unique in the catalogue)
//   3. supplier SKU       exact code key, same supplier (or supplier unread)
//   4. a code that matches apart from punctuation, or a code read as one kind
//      that equals an item's other kind (a SKU read as the maker's code)
//   5. words              the photo's description vs the item's name/variant
//
// Only 1–3 with no conflict can make an item the single EXACT suggestion. Words
// alone never do: two GPOs look alike, so a visual/description match is only
// ever a CANDIDATE for the worker to pick. Nothing here writes, and nothing
// here is a confirmation — the person still confirms the item and quantity.

const { codeKey, looseCodeKey, barcodeKey, brandKey, supplierKey, cleanCode } = require('./codes');
const { colourFacts, compareVariants, words } = require('./variants');

const MAX_CANDIDATES = 5;
const MIN_WORD_SCORE = 0.34;

const STOP = new Set(['the', 'and', 'with', 'for', 'of', 'a', 'an', 'in', 'to', 'pack', 'pk', 'each', 'ea', 'x', 'pcs', 'series', 'range', 'new']);

function tokens(text) {
  return words(text).filter((w) => w.length >= 2 && !STOP.has(w));
}

/** Words that describe an item, for the description fallback. */
function itemWords(item) {
  return new Set(tokens([item.name, item.brand, item.variant, item.colourFinish].filter(Boolean).join(' ')));
}

function productText(p) {
  return [p.brand, p.description, p.colourFinish, ...(p.variantDetails || []), ...(p.labelText || [])].filter(Boolean).join(' ');
}

function variantText(o) {
  return [o.name, o.description, o.colourFinish, o.variant, ...(o.variantDetails || [])].filter(Boolean).join(' ');
}

/**
 * @param {object} product  one cleaned product read from a photo (vision.js) or typed
 * @param {Array<object>} items live catalogue items, each with `identifiers`
 *   ([{ kind, valueKey, scope, packUnit, packSizeMilli, id }])
 * @returns {{ outcome: 'exact'|'candidates'|'none', candidates: Array<object> }}
 *   candidate: { itemId, evidence, strength, matchedValue, identifierId, conflicts, notes, score }
 */
function identify(product, items) {
  const live = (items || []).filter((i) => i && !i.archivedAt);
  const p = product || {};
  const want = {
    barcode: barcodeKey(p.barcode),
    mfr: codeKey(p.manufacturerCode),
    mfrLoose: looseCodeKey(p.manufacturerCode),
    sku: codeKey(p.supplierSku),
    skuLoose: looseCodeKey(p.supplierSku),
    brand: brandKey(p.brand),
    supplier: supplierKey(p.supplierName),
  };
  const photoVariant = variantText(p);
  const byItem = new Map();

  function add(item, c) {
    const prev = byItem.get(item.id);
    if (!prev || c.strength > prev.strength) byItem.set(item.id, { itemId: item.id, ...c });
  }

  for (const item of live) {
    const ids = Array.isArray(item.identifiers) ? item.identifiers : [];
    const conflictsWith = () => compareVariants(variantText(item), photoVariant).conflicts;
    for (const id of ids) {
      if (want.barcode && id.kind === 'barcode' && id.valueKey === want.barcode) {
        add(item, { evidence: 'barcode', strength: 100, matchedValue: id.value, identifierId: id.id, conflicts: [], notes: [] });
      }
      if (want.mfr && id.kind === 'manufacturer_code') {
        if (id.valueKey === want.mfr) {
          const brandClash = want.brand && id.scope && want.brand !== id.scope;
          const conflicts = conflictsWith();
          add(item, {
            evidence: 'manufacturer_code', strength: brandClash ? 60 : 90, matchedValue: id.value, identifierId: id.id,
            conflicts: brandClash ? [{ field: 'brand', wanted: p.brand, found: item.brand }, ...conflicts] : conflicts,
            notes: [],
          });
        } else if (want.mfrLoose && looseCodeKey(id.value) === want.mfrLoose) {
          add(item, { evidence: 'code_punctuation', strength: 55, matchedValue: id.value, identifierId: id.id, conflicts: conflictsWith(), notes: [`Code written ${cleanCode(p.manufacturerCode)} here, ${id.value} on the item`] });
        }
      }
      if (want.sku && id.kind === 'supplier_sku') {
        if (id.valueKey === want.sku) {
          const supplierClash = want.supplier && id.scope && want.supplier !== id.scope;
          add(item, {
            evidence: 'supplier_sku', strength: supplierClash ? 50 : 85, matchedValue: id.value, identifierId: id.id,
            conflicts: supplierClash ? [{ field: 'supplier', wanted: p.supplierName, found: item.supplierName }] : conflictsWith(),
            notes: [],
          });
        } else if (want.skuLoose && looseCodeKey(id.value) === want.skuLoose) {
          add(item, { evidence: 'code_punctuation', strength: 50, matchedValue: id.value, identifierId: id.id, conflicts: conflictsWith(), notes: [`Supplier SKU written ${cleanCode(p.supplierSku)} here, ${id.value} on the item`] });
        }
      }
      // A code read under one label that equals the item's OTHER kind of code.
      if (want.mfr && id.kind === 'supplier_sku' && id.valueKey === want.mfr) {
        add(item, { evidence: 'cross_kind', strength: 45, matchedValue: id.value, identifierId: id.id, conflicts: conflictsWith(), notes: ['The code read matches this item\'s supplier SKU, not its manufacturer code'] });
      }
      if (want.sku && id.kind === 'manufacturer_code' && id.valueKey === want.sku) {
        add(item, { evidence: 'cross_kind', strength: 45, matchedValue: id.value, identifierId: id.id, conflicts: conflictsWith(), notes: ['The code read matches this item\'s manufacturer code, not a supplier SKU'] });
      }
    }
  }

  // A brand-less code hit is only "exact" when one item owns that code.
  if (want.mfr && !want.brand) {
    const mfrHits = [...byItem.values()].filter((c) => c.evidence === 'manufacturer_code');
    if (mfrHits.length > 1) for (const c of mfrHits) { c.strength = 60; c.notes.push('Several brands use this code — check the brand'); }
  }

  // Description fallback — only for items no code already found.
  const photoWords = new Set(tokens(productText(p)));
  if (photoWords.size) {
    const photoColours = colourFacts(photoVariant).colours;
    for (const item of live) {
      if (byItem.has(item.id)) continue;
      const iw = itemWords(item);
      if (!iw.size) continue;
      let hit = 0;
      for (const w of iw) if (photoWords.has(w)) hit += 1;
      let score = hit / Math.max(3, iw.size);
      const conflicts = compareVariants(variantText(item), photoVariant).conflicts;
      if (conflicts.length) score -= 0.3;
      if (want.brand && brandKey(item.brand) && brandKey(item.brand) !== want.brand) score -= 0.25;
      if (score < MIN_WORD_SCORE) continue;
      const notes = ['Matched on the description only — check the code on the item'];
      if (!photoColours.size && colourFacts(variantText(item)).colours.size) notes.push('Colour not visible in the photo');
      add(item, { evidence: 'description', strength: Math.round(score * 40), matchedValue: null, identifierId: null, conflicts, notes, score: Number(score.toFixed(2)) });
    }
  }

  const candidates = [...byItem.values()].sort((a, b) => b.strength - a.strength).slice(0, MAX_CANDIDATES);
  const strongClean = candidates.filter((c) => c.strength >= 85 && c.conflicts.length === 0);
  if (strongClean.length === 1 && candidates.filter((c) => c.strength >= 85).length === 1) {
    return { outcome: 'exact', candidates };
  }
  return { outcome: candidates.length ? 'candidates' : 'none', candidates };
}

/**
 * Items that already carry one of the codes a NEW item would get — the
 * duplicate guard before a create. Exact keys only (same kind, same scope);
 * a punctuation-only or description likeness is shown as a hint, never blocks.
 */
function findDuplicates({ brand, manufacturerCode, supplierSku, supplierName, barcode }, items) {
  const live = (items || []).filter((i) => i && !i.archivedAt);
  const mfr = codeKey(manufacturerCode);
  const sku = codeKey(supplierSku);
  const bc = barcodeKey(barcode);
  const b = brandKey(brand) || '';
  const s = supplierKey(supplierName) || '';
  const out = [];
  for (const item of live) {
    for (const id of item.identifiers || []) {
      if (bc && id.kind === 'barcode' && id.valueKey === bc) out.push({ itemId: item.id, kind: 'barcode', value: id.value });
      else if (mfr && id.kind === 'manufacturer_code' && id.valueKey === mfr && (id.scope || '') === b) out.push({ itemId: item.id, kind: 'manufacturer_code', value: id.value });
      else if (sku && id.kind === 'supplier_sku' && id.valueKey === sku && (id.scope || '') === s) out.push({ itemId: item.id, kind: 'supplier_sku', value: id.value });
    }
  }
  return out;
}

module.exports = { identify, findDuplicates, tokens, MAX_CANDIDATES, MIN_WORD_SCORE };
