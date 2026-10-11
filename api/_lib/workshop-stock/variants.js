'use strict';

// Variant facts — colour/finish words and printed ratings — pulled out of free
// text so two descriptions can be COMPARED, never merged. Pure.
//
// This module only ever reads what is written. It never infers a rating or a
// colour from anything else (a white photo, a product family, a price): a value
// that is not printed is simply absent, and an absent value is "not confirmed",
// not "matches".

// Base colours. Spelling variants fold to one word; finish modifiers are kept
// separately so "vivid white" and "white" share a base colour (no conflict) but
// are not reported as the same finish.
const COLOUR_WORDS = Object.freeze({
  white: 'white', black: 'black', grey: 'grey', gray: 'grey', silver: 'silver',
  aluminium: 'aluminium', aluminum: 'aluminium', chrome: 'chrome', stainless: 'stainless',
  bronze: 'bronze', brass: 'brass', gold: 'gold', champagne: 'champagne', beige: 'beige',
  ivory: 'ivory', cream: 'cream', red: 'red', blue: 'blue', green: 'green', yellow: 'yellow',
  orange: 'orange', purple: 'purple', pink: 'pink', brown: 'brown', clear: 'clear',
  transparent: 'clear', titanium: 'titanium', nickel: 'nickel', anthracite: 'anthracite',
  graphite: 'graphite', charcoal: 'charcoal', slate: 'slate',
});
const FINISH_WORDS = Object.freeze(['vivid', 'matt', 'matte', 'gloss', 'satin', 'brushed', 'polished', 'urban', 'pure', 'electric', 'warm', 'cool']);

function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

/** { colours: Set<string>, finishes: Set<string> } from free text. */
function colourFacts(text) {
  const colours = new Set();
  const finishes = new Set();
  for (const w of words(text)) {
    if (COLOUR_WORDS[w]) colours.add(COLOUR_WORDS[w]);
    else if (FINISH_WORDS.includes(w)) finishes.add(w === 'matte' ? 'matt' : w);
  }
  return { colours, finishes };
}

// Printed ratings. Each match becomes DIMENSION:VALUE (e.g. "A:10", "MM2:2.5").
const RATING_PATTERNS = [
  { dim: 'MM2', re: /(\d+(?:\.\d+)?)\s*(?:mm²|mm2|sq\.?\s*mm|sqmm)/gi },
  { dim: 'KA', re: /(\d+(?:\.\d+)?)\s*ka\b/gi },
  { dim: 'MA', re: /(\d+(?:\.\d+)?)\s*ma\b/gi },
  { dim: 'A', re: /(\d+(?:\.\d+)?)\s*(?:a|amp|amps)\b/gi },
  { dim: 'V', re: /(\d+(?:\.\d+)?)\s*(?:v|volt|volts|vac)\b/gi },
  { dim: 'W', re: /(\d+(?:\.\d+)?)\s*(?:w|watt|watts)\b/gi },
  { dim: 'MM', re: /(\d+(?:\.\d+)?)\s*mm\b(?!\s*²|2)/gi },
  { dim: 'IP', re: /\bip\s?(\d{2})\b/gi },
  { dim: 'POLE', re: /(\d)\s*(?:p|pole)\b/gi },
  { dim: 'GANG', re: /(\d)\s*gang\b/gi },
  { dim: 'CORE', re: /(\d)\s*(?:c|core)\b/gi },
];

/** Map<dimension, Set<value>> of every rating printed in `text`. */
function ratingFacts(text) {
  const out = new Map();
  const s = String(text || '');
  for (const { dim, re } of RATING_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      const v = String(Number(m[1]));
      if (!out.has(dim)) out.set(dim, new Set());
      out.get(dim).add(v);
    }
  }
  // "double"/"twin" outlets are 2-gang in site language
  if (/\b(double|twin)\b/i.test(s) && !out.has('GANG')) out.set('GANG', new Set(['2']));
  if (/\bsingle\b/i.test(s) && !out.has('GANG')) out.set('GANG', new Set(['1']));
  return out;
}

const DIM_LABEL = { MM2: 'mm²', KA: 'kA', MA: 'mA', A: 'A', V: 'V', W: 'W', MM: 'mm', IP: 'IP', POLE: '-pole', GANG: '-gang', CORE: '-core' };

function ratingLabel(dim, v) {
  if (dim === 'IP') return `IP${v}`;
  return `${v}${DIM_LABEL[dim] || ''}`;
}

/**
 * Compare what we hold (`wanted`) with what a source says (`found`).
 * Returns { conflicts: [{ field, wanted, found }], unconfirmed: [field] }.
 * A conflict needs BOTH sides to state the same kind of fact with no overlap.
 */
function compareVariants(wantedText, foundText) {
  const conflicts = [];
  const unconfirmed = [];
  const w = colourFacts(wantedText);
  const f = colourFacts(foundText);
  if (w.colours.size && f.colours.size) {
    const overlap = [...w.colours].some((c) => f.colours.has(c));
    if (!overlap) conflicts.push({ field: 'colour', wanted: [...w.colours].join('/'), found: [...f.colours].join('/') });
    else if (w.finishes.size && ![...w.finishes].some((x) => f.finishes.has(x))) unconfirmed.push('finish');
  } else if (w.colours.size) {
    unconfirmed.push('colour');
  }
  const wr = ratingFacts(wantedText);
  const fr = ratingFacts(foundText);
  for (const [dim, wv] of wr) {
    const fv = fr.get(dim);
    if (!fv) { unconfirmed.push(ratingLabel(dim, [...wv][0])); continue; }
    if (![...wv].some((v) => fv.has(v))) {
      conflicts.push({ field: 'rating', wanted: [...wv].map((v) => ratingLabel(dim, v)).join('/'), found: [...fv].map((v) => ratingLabel(dim, v)).join('/') });
    }
  }
  return { conflicts, unconfirmed };
}

module.exports = { colourFacts, ratingFacts, compareVariants, ratingLabel, words };
