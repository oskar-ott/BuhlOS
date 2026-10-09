'use strict';

// Deterministic product verification (Workshop Stock lookup). Pure.
//
// Compares the code we hold against what ONE retrieved source actually says.
// No model, no confidence score: a verdict is the result of string rules a
// person can re-check by opening the source link.
//
//   manufacturer_code_matched  the exact code (punctuation kept) is the page's
//                              OWN product code — in its structured product data
//                              or its title/heading — the brand is confirmed (the
//                              maker's own site, or the page names that brand),
//                              the code is specific enough to stand alone, and no
//                              printed variant detail conflicts
//   possible_match             a weaker hit: code only in body text, only in a
//                              wholesaler's SKU field, only in a SEARCH LISTING
//                              (never opened), punctuation differs, the brand is
//                              unconfirmed, or a colour/rating conflicts
//   no_match                   the source doesn't show this code
//
// "Matched" is never certification: it says a public listing uses this code for
// this product, nothing about suitability or compliance.

const { cleanCode, codeKey, looseCodeKey, isWeakCode, brandKey } = require('./codes');
const { compareVariants, words } = require('./variants');

const STRIP_EDGES = /^[.\-/_#+*:]+|[.\-/_#+*:]+$/g;

/** Find the code in free text as a whole token (or two adjacent tokens). */
function findCodeInText(text, wantKey, wantLoose) {
  const toks = String(text || '').split(/[\s,;|()[\]{}<>"'`]+/).map((t) => t.replace(STRIP_EDGES, '')).filter(Boolean);
  let loose = null;
  for (let i = 0; i < toks.length; i++) {
    const one = toks[i];
    const two = i + 1 < toks.length ? one + toks[i + 1] : null;
    for (const cand of two ? [one, two] : [one]) {
      if (cand.length > 48) continue;
      const k = codeKey(cand);
      if (!k) continue;
      if (k === wantKey) return { match: 'exact', asWritten: cleanCode(cand === one ? one : `${one} ${toks[i + 1]}`) };
      if (!loose && wantLoose && looseCodeKey(cand) === wantLoose) loose = { match: 'punctuation', asWritten: cleanCode(cand === one ? one : `${one} ${toks[i + 1]}`) };
    }
  }
  return loose;
}

function fieldMatch(value, wantKey, wantLoose) {
  const k = codeKey(value);
  if (!k) return null;
  if (k === wantKey) return 'exact';
  if (wantLoose && looseCodeKey(value) === wantLoose) return 'punctuation';
  return null;
}

function wantedVariantText(w) {
  return [w.colourFinish, ...(w.variantDetails || [])].filter(Boolean).join(' ');
}

/**
 * Verify one fetched page.
 * @param {{ brand?, manufacturerCode, colourFinish?, variantDetails? }} wanted
 * @param {ReturnType<import('./page-extract').extractPageFacts>} facts
 * @param {{ kind: 'manufacturer'|'supplier', domain: string, brands: string[] }} source
 */
function verifyPage(wanted, facts, source) {
  const wantKey = codeKey(wanted.manufacturerCode);
  const wantLoose = looseCodeKey(wanted.manufacturerCode);
  const reasons = [];
  if (!wantKey) return { verdict: 'no_match', reasons: ['No code to check'], conflicts: [], unconfirmed: [], candidate: null };

  // 1) the page's own product code(s)
  let hit = null;
  for (const p of facts.products || []) {
    for (const [field, value] of [['mpn', p.mpn], ['model', p.model], ['productID', p.productID], ['sku', p.sku], ['sku', p.offerSku]]) {
      const m = fieldMatch(value, wantKey, wantLoose);
      if (m && (!hit || (hit.match !== 'exact' && m === 'exact') || (hit.field === 'sku' && field !== 'sku' && m === hit.match))) {
        hit = { where: 'structured_data', field, match: m, asWritten: cleanCode(value), product: p };
      }
    }
  }
  for (const [field, value] of [['mpn', facts.meta && facts.meta.mpn], ['sku', facts.meta && facts.meta.sku]]) {
    const m = fieldMatch(value, wantKey, wantLoose);
    if (m && !hit) hit = { where: 'structured_data', field, match: m, asWritten: cleanCode(value), product: null };
  }
  // 2) the title / main heading
  if (!hit || hit.match !== 'exact') {
    for (const [field, value] of [['title', facts.title], ['h1', facts.h1], ['title', facts.og && facts.og.title]]) {
      const t = findCodeInText(value, wantKey, wantLoose);
      if (t && (!hit || (t.match === 'exact' && hit.match !== 'exact'))) hit = { where: 'page_title', field, match: t.match, asWritten: t.asWritten, product: hit ? hit.product : null };
    }
  }
  // 3) anywhere in the visible text (weakest: "related products" lists live here too)
  if (!hit) {
    const t = findCodeInText(facts.text, wantKey, wantLoose);
    if (t) hit = { where: 'page_text', field: 'text', match: t.match, asWritten: t.asWritten, product: null };
  }

  const product = (hit && hit.product) || (facts.products || [])[0] || null;
  const candidate = {
    name: (product && product.name) || facts.h1 || facts.og.title || facts.title || null,
    brand: (product && product.brand) || (facts.meta && facts.meta.brand) || null,
    code: hit ? hit.asWritten : null,
    gtin: product ? product.gtin : null,
    colour: product ? product.color : null,
    imageUrl: (product && product.image) || facts.og.image || null,
  };
  if (!hit) return { verdict: 'no_match', reasons: ['This page doesn\'t show the code'], conflicts: [], unconfirmed: [], candidate };

  // brand
  const wantBrand = brandKey(wanted.brand);
  const pageBrand = brandKey(candidate.brand);
  let brandConfirmed = null;
  const conflicts = [];
  if (source.kind === 'manufacturer' && (!wantBrand || source.brands.includes(wantBrand))) brandConfirmed = true;
  if (pageBrand && wantBrand) {
    if (pageBrand === wantBrand) brandConfirmed = true;
    else if (!(source.kind === 'manufacturer' && source.brands.includes(wantBrand))) {
      brandConfirmed = false;
      conflicts.push({ field: 'brand', wanted: wanted.brand, found: candidate.brand });
    }
  }
  if (source.kind === 'manufacturer' && wantBrand && !source.brands.includes(wantBrand)) {
    brandConfirmed = false;
    conflicts.push({ field: 'brand', wanted: wanted.brand, found: source.domain });
  }
  // variants: what we hold vs the product's own name/colour (not the whole page)
  const foundVariant = [candidate.name, candidate.colour, facts.title, facts.h1].filter(Boolean).join(' ');
  // a page with no brand field that names the brand in the product's own title
  if (brandConfirmed === null && wantBrand && !pageBrand && ` ${words(foundVariant).join(' ')} `.includes(` ${wantBrand} `)) {
    brandConfirmed = true;
  }
  const v = compareVariants(wantedVariantText(wanted), foundVariant);
  conflicts.push(...v.conflicts);

  const ownCode = hit.where === 'page_title' || (hit.where === 'structured_data' && !(hit.field === 'sku' && source.kind === 'supplier'));
  if (hit.match !== 'exact') reasons.push(`The source writes the code as ${hit.asWritten}`);
  if (hit.where === 'page_text') reasons.push('The code is on the page, but not as this product\'s own code');
  if (hit.where === 'structured_data' && hit.field === 'sku' && source.kind === 'supplier') reasons.push('Matched the wholesaler\'s SKU field — check it is the maker\'s code');
  if (brandConfirmed !== true && !conflicts.some((c) => c.field === 'brand')) reasons.push(wantBrand ? 'The page doesn\'t confirm the brand' : 'Brand not read from the photo — check it');
  if (isWeakCode(wanted.manufacturerCode)) reasons.push('The code is too short to identify one product on its own');
  for (const c of conflicts) reasons.push(c.field === 'brand' ? `Brand differs: ${c.found}` : `${c.field === 'colour' ? 'Colour' : 'Rating'} differs: the source says ${c.found}, we have ${c.wanted}`);

  const strong = hit.match === 'exact' && ownCode && brandConfirmed === true && conflicts.length === 0 && !isWeakCode(wanted.manufacturerCode);
  return {
    verdict: strong ? 'manufacturer_code_matched' : 'possible_match',
    where: hit.where,
    field: hit.field,
    codeMatch: hit.match,
    brandConfirmed,
    conflicts,
    unconfirmed: v.unconfirmed,
    reasons,
    candidate,
  };
}

/** A search listing that was NOT opened (or couldn't be): preliminary evidence only. */
function verifyListing(wanted, listing) {
  const wantKey = codeKey(wanted.manufacturerCode);
  const wantLoose = looseCodeKey(wanted.manufacturerCode);
  if (!wantKey) return { verdict: 'no_match', reasons: [], conflicts: [], unconfirmed: [], candidate: null };
  const t = findCodeInText(listing.title, wantKey, wantLoose) || (listing.snippets || []).map((s) => findCodeInText(s, wantKey, wantLoose)).find(Boolean);
  const candidate = { name: listing.title || null, brand: null, code: t ? t.asWritten : null, gtin: null, colour: null, imageUrl: null };
  if (!t) return { verdict: 'no_match', reasons: [], conflicts: [], unconfirmed: [], candidate };
  const v = compareVariants(wantedVariantText(wanted), listing.title || '');
  const reasons = ['Found in a search listing — the product page itself wasn\'t confirmed'];
  if (t.match !== 'exact') reasons.push(`The listing writes the code as ${t.asWritten}`);
  for (const c of v.conflicts) reasons.push(`${c.field === 'colour' ? 'Colour' : 'Rating'} differs: the listing says ${c.found}, we have ${c.wanted}`);
  return { verdict: 'possible_match', where: 'listing', field: 'title', codeMatch: t.match, brandConfirmed: null, conflicts: v.conflicts, unconfirmed: v.unconfirmed, reasons, candidate };
}

module.exports = { verifyPage, verifyListing, findCodeInText };
