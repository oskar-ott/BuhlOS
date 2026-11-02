import { canonicalWords } from "./trade-terms";

/**
 * Workshop Stock — the location matrix: the racks in the workshop and the rules
 * saying which words go in which bin ("iconic switch" → Rack 3, shelf B, bin 4).
 * Pure. Saved by the office at /stock/locations, read at the camera table.
 *
 * A rule matches when ALL its words are in the product's text (trade names and
 * plurals folded, the same way the list search compares). The rule with the most
 * words wins, so "iconic switch" beats "iconic". An item only ever keeps the
 * location TEXT it was given, so changing the matrix never moves recorded stock.
 */

export interface MatrixRack {
  id: string;
  name: string;
  shelves: number;
  bins: number;
}

export interface MatrixRule {
  id: string;
  words: string;
  rackId: string;
  shelf: number;
  bin: number;
}

export interface LocationMatrix {
  racks: MatrixRack[];
  rules: MatrixRule[];
}

export const MAX_SHELVES = 26;
export const MAX_BINS = 60;

/** "3" → "Rack 3"; a rack named in words stays as it was typed ("Cable bay"). */
export function rackLabel(name: string): string {
  const text = name.trim();
  return /^[A-Za-z0-9]{1,3}$/.test(text) ? `Rack ${text.toUpperCase()}` : text;
}

/** Shelves are lettered: shelf 1 is A. Rules keep the number, so only what people read is a letter. */
export function shelfLabel(shelf: number): string {
  return String.fromCharCode(64 + shelf);
}

/**
 * The location text an item is given. "Rack 3 Shelf B, Bin 4" reads on the
 * existing list as shelf "Rack 3 Shelf B" holding "Bin 4" (location.ts splits at
 * the comma), so the phone's by-shelf list needs no change.
 */
export function locationText(rack: Pick<MatrixRack, "name">, shelf: number, bin: number): string {
  return `${rackLabel(rack.name)} Shelf ${shelfLabel(shelf)}, Bin ${bin}`;
}

export interface RuleMatch {
  rule: MatrixRule;
  rack: MatrixRack;
  location: string;
}

function ruleWords(words: string): string[] {
  return [...new Set(canonicalWords(words))];
}

/** Where this text goes: the most specific rule that fits, or null. Ties go to the rule listed first. */
export function ruleFor(text: string | null | undefined, matrix: LocationMatrix | null | undefined): RuleMatch | null {
  if (!matrix || !text) return null;
  const have = new Set(canonicalWords(text));
  let best: { match: RuleMatch; size: number } | null = null;
  for (const rule of matrix.rules) {
    const rack = matrix.racks.find((r) => r.id === rule.rackId);
    if (!rack) continue;
    const want = ruleWords(rule.words);
    if (!want.length || !want.every((w) => have.has(w))) continue;
    if (!best || want.length > best.size) best = { match: { rule, rack, location: locationText(rack, rule.shelf, rule.bin) }, size: want.length };
  }
  return best ? best.match : null;
}

/** Every bin on every rack, ruled or not — the suggestions on a location field. */
export function matrixLocations(matrix: LocationMatrix | null | undefined): string[] {
  if (!matrix) return [];
  const out: string[] = [];
  for (const rack of matrix.racks) {
    for (let shelf = 1; shelf <= rack.shelves; shelf += 1) {
      for (let bin = 1; bin <= rack.bins; bin += 1) out.push(locationText(rack, shelf, bin));
    }
  }
  return out.sort((a, b) => a.localeCompare(b, "en-AU", { numeric: true, sensitivity: "base" }));
}

export function binKey(rackId: string, shelf: number, bin: number): string {
  return `${rackId}:${shelf}:${bin}`;
}

export interface BinRef {
  rack: MatrixRack;
  shelf: number;
  bin: number;
}

/** The bin a location's text names, or null when it isn't one on this matrix. Reads what locationText writes. */
export function binAt(location: string | null | undefined, matrix: LocationMatrix | null | undefined): BinRef | null {
  if (!matrix || !location) return null;
  const hit = /^(.+) shelf ([a-z]), bin (\d+)$/i.exec(location.replace(/\s+/g, " ").trim());
  if (!hit) return null;
  const rack = matrix.racks.find((r) => rackLabel(r.name).toLowerCase() === hit[1]!.toLowerCase());
  const shelf = hit[2]!.toUpperCase().charCodeAt(0) - 64;
  const bin = Number(hit[3]);
  return rack && shelf >= 1 && shelf <= rack.shelves && bin >= 1 && bin <= rack.bins ? { rack, shelf, bin } : null;
}

export function rulesInBin(matrix: LocationMatrix, rackId: string, shelf: number, bin: number): MatrixRule[] {
  return matrix.rules.filter((r) => r.rackId === rackId && r.shelf === shelf && r.bin === bin);
}

/** Rules a smaller rack would leave pointing at nothing — saved racks can't shrink past them. */
export function rulesOutsideRack(matrix: LocationMatrix, rackId: string, shelves: number, bins: number): MatrixRule[] {
  return matrix.rules.filter((r) => r.rackId === rackId && (r.shelf > shelves || r.bin > bins));
}
