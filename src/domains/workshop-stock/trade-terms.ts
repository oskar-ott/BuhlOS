/**
 * Trade names for the list search — what electricians call the same thing,
 * folded to one word, so "power point" finds the "GPO" and "twin and earth"
 * finds the "TPS". Pure; compares only, never rewrites what's shown.
 *
 * Mirrors api/_lib/workshop-stock/trade-terms.js (the photo matcher's copy);
 * client-logic.test.ts pins the two together.
 */

export const PHRASES: ReadonlyArray<readonly [string, string]> = [
  ["general purpose outlet", "gpo"],
  ["switched socket outlet", "gpo"],
  ["residual current device", "rcd"],
  ["twin and earth", "tps"],
  ["socket outlet", "gpo"],
  ["power point", "gpo"],
  ["power outlet", "gpo"],
  ["safety switch", "rcd"],
  ["circuit breaker", "mcb"],
  ["junction box", "jb"],
  ["t and e", "tps"],
];

export const WORDS: Readonly<Record<string, string>> = {
  powerpoint: "gpo",
  socket: "gpo",
  outlet: "gpo",
  breaker: "mcb",
  twin: "double",
  dbl: "double",
  jbox: "jb",
};

/** "boxes" → "box", "gpos" → "gpo", "glands" → "gland"; "brass", "plus" stay. */
export function singular(w: string): string {
  if (w.length >= 5 && /(x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length >= 4 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

const PHRASE_WORDS = PHRASES.map(([phrase, word]) => [phrase.split(" "), word] as const);

/** The comparable words of a text: lowercased, plurals made singular, trade names folded. */
export function canonicalWords(text: string | null | undefined): string[] {
  const words = String(text ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean).map(singular);
  const out: string[] = [];
  for (let i = 0; i < words.length; ) {
    const hit = PHRASE_WORDS.find(([p]) => p.every((w, j) => words[i + j] === w));
    if (hit) {
      out.push(hit[1]);
      i += hit[0].length;
    } else {
      out.push(WORDS[words[i]!] ?? words[i]!);
      i += 1;
    }
  }
  return out;
}
