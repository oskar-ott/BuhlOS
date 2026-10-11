'use strict';

// Trade names — what electricians call the same thing, folded to one word so a
// "power point" on a box, a "GPO" in the list and a "socket outlet" from a
// wholesaler's listing find each other. Pure.
//
// Used where words are COMPARED (the photo-description fallback in match.js);
// never to rewrite what is stored or shown. Mirrored for the list search in
// src/domains/workshop-stock/trade-terms.ts — a parity test pins the two.

// Multi-word names, longest first. Text is lowercased and '&' read as 'and'
// before these apply, and punctuation is a space ("t&e" → "t and e").
const PHRASES = Object.freeze([
  ['general purpose outlet', 'gpo'],
  ['switched socket outlet', 'gpo'],
  ['residual current device', 'rcd'],
  ['twin and earth', 'tps'],
  ['socket outlet', 'gpo'],
  ['power point', 'gpo'],
  ['power outlet', 'gpo'],
  ['safety switch', 'rcd'],
  ['circuit breaker', 'mcb'],
  ['junction box', 'jb'],
  ['t and e', 'tps'],
]);

// Single words (after the phrases).
const WORDS = Object.freeze({
  powerpoint: 'gpo',
  socket: 'gpo',
  outlet: 'gpo',
  breaker: 'mcb',
  twin: 'double',
  dbl: 'double',
  jbox: 'jb',
});

/** "boxes" → "box", "gpos" → "gpo", "glands" → "gland"; "brass", "plus" stay. */
function singular(w) {
  if (w.length >= 5 && /(x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length >= 4 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

const PHRASE_WORDS = PHRASES.map(([phrase, word]) => [phrase.split(' '), word]);

/** The comparable words of a text: lowercased, plurals made singular, trade names folded. */
function canonicalWords(text) {
  // plurals first, so "power points" is a "power point"
  const words = String(text || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean).map(singular);
  const out = [];
  for (let i = 0; i < words.length;) {
    const hit = PHRASE_WORDS.find(([p]) => p.every((w, j) => words[i + j] === w));
    if (hit) {
      out.push(hit[1]);
      i += hit[0].length;
    } else {
      out.push(WORDS[words[i]] || words[i]);
      i += 1;
    }
  }
  return out;
}

module.exports = { PHRASES, WORDS, singular, canonicalWords };
