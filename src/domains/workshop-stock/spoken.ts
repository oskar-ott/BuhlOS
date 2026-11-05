import type { NewItemDraft } from "./intake";
import type { StockUnit } from "./schema";

/**
 * Workshop Stock, camera table — what was said, split into the boxes of a card, plus the
 * few fixed phrases that act. Pure: nothing here saves anything, the screen does that.
 */

export type SpokenCommand = "undo" | "ignore" | "again" | "stop";

export interface Spoken {
  /** "scratch that": back to what the card held before anyone spoke */
  scratch: boolean;
  /** "add it" on its own or on the end of a phrase, or "done" on its own */
  save: boolean;
  /** a whole phrase that does something, and is never a name */
  command: SpokenCommand | null;
  /** "number 2", "the second one": the list on the card, if it has one. The words are still split as usual for a card with no list. */
  pick: number | null;
  /** what was said, without the "add it" */
  words: string;
  name: string | null;
  /** digits, as the amount box shows them */
  count: string | null;
  unit: StockUnit | null;
  location: string | null;
}

const ONES: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Readonly<Record<string, number>> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
/** Heard on its own, these are numbers: a recogniser with no sentence around it writes "for" for 4. */
const SOUNDS_LIKE: Readonly<Record<string, string>> = { to: "2", too: "2", for: "4", fore: "4", ate: "8", won: "1" };
const DIGITS = /^\d{1,6}(?:\.\d{1,3})?$/;

const UNIT_WORDS: Readonly<Record<string, StockUnit>> = {
  each: "each",
  metre: "metre", metres: "metre", meter: "metre", meters: "metre",
  length: "length", lengths: "length",
  bag: "bag", bags: "bag",
  box: "box", boxes: "box",
  roll: "roll", rolls: "roll",
  pack: "pack", packs: "pack",
};
/** A number after one of these is part of the product's name: "cat 6", "IP 65", "series 2000". */
const NAMES_A_NUMBER = new Set(["cat", "category", "ip", "type", "size", "model", "series", "number", "no", "class", "gen", "din", "rj", "version", "mark", "mk"]);
/** Said just before a count, and not part of the name. */
const COUNT_WORDS = new Set(["times", "x", "by", "quantity", "qty", "count"]);
const SCRATCH = new Set(["scratch that", "clear that", "start again"]);
/** Two words at least, or one nobody says about a product: talk nearby shouldn't save. */
const SAVE_ENDINGS = new Set(["add it", "log it", "save it", "add that", "log that", "save that"]);
const COMMANDS: Readonly<Record<string, SpokenCommand>> = {
  undo: "undo", "undo that": "undo", "undo it": "undo",
  "not stock": "ignore", "ignore it": "ignore", "ignore that": "ignore",
  "read it again": "again", "read again": "again",
  "stop listening": "stop",
};
const ORDINALS: Readonly<Record<string, number>> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9 };
const LETTERS: Readonly<Record<string, string>> = { a: "A", hey: "A", eh: "A", b: "B", be: "B", bee: "B", c: "C", see: "C", sea: "C", d: "D", dee: "D", e: "E", f: "F", eff: "F" };

/** Whole numbers said in words, or a digit before a scale ("2 hundred"). Null if the words don't make one number. */
function wholeFrom(tokens: readonly string[]): number | null {
  if (!tokens.length) return null;
  let total = 0;
  let current = 0;
  let afterScale = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const next = tokens[i + 1];
    const beforeScale = next === "hundred" || next === "thousand" || next === "dozen";
    if (t === "and") {
      if (!afterScale || !next) return null;
      afterScale = false;
    } else if (t === "a" || t === "an" || /^\d+$/.test(t)) {
      if (i !== 0 || !beforeScale) return null;
      current = t === "a" || t === "an" ? 1 : Number(t);
    } else if (t in ONES) {
      const rest = current % 100;
      if (rest !== 0 && !(rest >= 20 && rest % 10 === 0 && ONES[t]! < 10)) return null;
      current += ONES[t]!;
      afterScale = false;
    } else if (t in TENS) {
      if (current % 100 !== 0) return null;
      current += TENS[t]!;
      afterScale = false;
    } else if (t === "hundred") {
      if (current < 1 || current > 99) return null;
      current *= 100;
      afterScale = true;
    } else if (t === "thousand") {
      if (current < 1) return null;
      total += current * 1000;
      current = 0;
      afterScale = true;
    } else if (t === "dozen") {
      if (current < 1 || current > 99 || next) return null;
      current *= 12;
    } else {
      return null;
    }
  }
  return total + current;
}

/** "forty" → "40", "two hundred and fifty" → "250", "twelve point five" → "12.5", "40" → "40". */
export function spokenNumber(tokens: readonly string[]): string | null {
  if (tokens.length === 1 && DIGITS.test(tokens[0]!)) return tokens[0]!;
  const at = tokens.indexOf("point");
  const whole = wholeFrom(at < 0 ? tokens : tokens.slice(0, at));
  if (whole === null) return null;
  if (at < 0) return String(whole);
  const fraction = tokens.slice(at + 1).map((t) => (/^\d$/.test(t) ? t : ONES[t] !== undefined && ONES[t]! < 10 ? String(ONES[t]) : null));
  return fraction.length && fraction.length <= 3 && fraction.every(Boolean) ? `${whole}.${fraction.join("")}` : null;
}

const wordsOf = (text: string) =>
  text.replace(/(\d),(\d{3})\b/g, "$1$2").replace(/[,;:!?"“”]+/g, " ").replace(/\.(?=\s|$)/g, " ").trim().split(/\s+/).filter(Boolean);

function sayable(token: string | undefined): string | null {
  if (!token) return null;
  const t = token.toLowerCase();
  if (/^\d+$/.test(t)) return t;
  if (ONES[t] !== undefined) return String(ONES[t]);
  if (SOUNDS_LIKE[t]) return SOUNDS_LIKE[t]!;
  return LETTERS[t] ?? (/^[a-z]$/.test(t) ? t.toUpperCase() : null);
}

/** A shelf said as a letter is the same shelf as its number: B = 2. */
const shelfNumber = (shelf: string) => (/^[A-Z]$/i.test(shelf) ? String(shelf.toUpperCase().charCodeAt(0) - 64) : shelf);

/** The bin the list already calls this, so a spoken one lands on the same spelling; otherwise as it was said. */
function binText(rack: string, shelf: string, bin: string | null, known: readonly string[]): string {
  const match = known.find((text) => {
    const m = /^rack\s+(\S+)\s+shelf\s+(\S+?),?(?:\s+bin\s+(\S+))?$/i.exec(text.trim());
    return Boolean(m) && m![1]!.toUpperCase() === rack.toUpperCase() && shelfNumber(m![2]!) === shelfNumber(shelf) && (m![3] ?? null) === bin;
  });
  return match ?? `Rack ${rack} Shelf ${shelf}${bin ? `, Bin ${bin}` : ""}`;
}

/** "rack 3 shelf b bin 4" anywhere in what was said, lifted out. */
function takeLocation(words: string[], known: readonly string[]): string | null {
  const lower = words.map((w) => w.toLowerCase());
  for (let i = 0; i + 3 < lower.length; i++) {
    if (lower[i] !== "rack" || lower[i + 2] !== "shelf") continue;
    const rack = sayable(lower[i + 1]);
    const shelf = sayable(lower[i + 3]);
    if (!rack || !shelf) continue;
    let end = i + 4;
    let bin: string | null = null;
    if (lower[end] === "bin") {
      const two = spokenNumber(lower.slice(end + 1, end + 3));
      bin = two && !two.includes(".") ? two : sayable(lower[end + 1]);
      if (bin) end += two && !two.includes(".") ? 3 : 2;
      else end += 1;
    }
    let start = i;
    if (lower[start - 1] === "to" && lower[start - 2] && ["goes", "go"].includes(lower[start - 2]!)) start -= 2;
    else if (["in", "on", "at"].includes(lower[start - 1] ?? "")) start -= 1;
    words.splice(start, end - start);
    return binText(rack, shelf, bin, known);
  }
  return null;
}

/** A count on the end of what was said: "… forty", "… 100 metres", "… times 6", "… 12 of them". */
function takeCount(words: string[]): { count: string; unit: StockUnit | null } | null {
  const lower = words.map((w) => w.toLowerCase());
  let end = lower.length;
  if (lower[end - 1] === "off" || ["pieces", "items", "units"].includes(lower[end - 1] ?? "")) end -= 1;
  else if (lower[end - 2] === "of" && ["them", "those", "these"].includes(lower[end - 1] ?? "")) end -= 2;
  const unit = UNIT_WORDS[lower[end - 1] ?? ""] ?? null;
  if (unit) end -= 1;
  // The longest run that makes one number, so "two hundred and fifty" isn't read as 50.
  for (let start = Math.max(0, end - 6); start < end; start++) {
    const count = spokenNumber(lower.slice(start, end));
    if (count === null) continue;
    const before = lower[start - 1];
    if (before && NAMES_A_NUMBER.has(before)) return null;
    const from = before && COUNT_WORDS.has(before) ? start - 1 : start;
    words.splice(from);
    return { count, unit };
  }
  return null;
}

/** "forty of the Iconic switches", "100 metres of TPS". */
function takeLeadingCount(words: string[]): { count: string; unit: StockUnit | null } | null {
  const lower = words.map((w) => w.toLowerCase());
  const of = lower.indexOf("of");
  if (of < 1 || of > 6 || of === lower.length - 1) return null;
  const unit = UNIT_WORDS[lower[of - 1]!] ?? null;
  const count = spokenNumber(lower.slice(0, unit ? of - 1 : of));
  if (count === null) return null;
  words.splice(0, of + 1);
  if (words[0]?.toLowerCase() === "the") words.shift();
  return { count, unit };
}

/** "number 2", "pick two", "the second one", "second". Only a whole phrase, and only 1 to 9: a bare "two" is a count. */
function pickFrom(whole: string): number | null {
  const ordinal = /^(?:the )?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)(?: one)?$/.exec(whole);
  if (ordinal) return ORDINALS[ordinal[1]!]!;
  const said = /^(?:number|option|pick|choose) (?:number )?(\S+)$/.exec(whole);
  const digit = said ? sayable(said[1]) : null;
  return digit && /^[1-9]$/.test(digit) ? Number(digit) : null;
}

/** "… add it", "… forty and log it": the ending comes off, and says so. */
function takeSave(words: string[]): boolean {
  if (words.length < 2 || !SAVE_ENDINGS.has(words.slice(-2).join(" ").toLowerCase())) return false;
  words.splice(-2);
  if (["and", "then"].includes(words[words.length - 1]?.toLowerCase() ?? "")) words.pop();
  return true;
}

export function parseSpoken(text: string, knownBins: readonly string[] = []): Spoken {
  const words = wordsOf(text);
  const nothing: Spoken = { scratch: false, save: false, command: null, pick: null, words: "", name: null, count: null, unit: null, location: null };
  if (!words.length) return nothing;
  const whole = words.join(" ").toLowerCase();
  if (SCRATCH.has(whole)) return { ...nothing, scratch: true };
  if (COMMANDS[whole]) return { ...nothing, command: COMMANDS[whole]! };
  if (whole === "done") return { ...nothing, save: true };
  const pick = pickFrom(whole);
  const save = takeSave(words);
  const said = words.join(" ");
  const lower = said.toLowerCase();
  if (words.length === 1 && SOUNDS_LIKE[lower]) return { ...nothing, save, words: said, count: SOUNDS_LIKE[lower]! };
  const location = takeLocation(words, knownBins);
  const counted = takeLeadingCount(words) ?? takeCount(words);
  const rest = words.join(" ").trim().replace(/\s+and$/i, "");
  const name = rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : null;
  return { scratch: false, save, command: null, pick, words: said, name, count: counted?.count ?? null, unit: counted?.unit ?? null, location };
}

/** What the card held before anyone spoke, and whether a spoken name is already in it. */
export interface SpokenMemory {
  before: NewItemDraft;
  named: boolean;
}

/**
 * What a phrase does to a new-item card. The first name said replaces what the label
 * gave; a later phrase adds to it, because a recogniser ends a phrase at any short pause.
 */
export function applySpoken(draft: NewItemDraft, said: Spoken, memory: SpokenMemory | null): { draft: NewItemDraft; memory: SpokenMemory | null } {
  if (said.scratch) return memory ? { draft: memory.before, memory: null } : { draft, memory };
  const next = { ...draft };
  if (said.name) next.name = memory?.named ? `${draft.name} ${said.name.charAt(0).toLowerCase()}${said.name.slice(1)}`.slice(0, 160) : said.name.slice(0, 160);
  if (said.count) next.amount = said.count;
  if (said.unit) next.unit = said.unit;
  if (said.location) {
    next.location = said.location;
    next.locationFrom = null;
  }
  return { draft: next, memory: { before: memory?.before ?? draft, named: Boolean(memory?.named || said.name) } };
}
