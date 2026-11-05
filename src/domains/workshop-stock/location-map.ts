import { itemWords } from "./intake";
import { binAt, binKey, locationText, rackLabel, ruleFor, shelfLabel, type LocationMatrix, type MatrixRack } from "./location-matrix";
import type { StockItem } from "./schema";
import { OTHER_TYPE, typeOf } from "./types";

/**
 * Workshop Stock — the shelf map: what the recorded stock says is in each bin, and
 * where something without a place should go. Pure. Read from the items' location
 * text; nothing here moves anything, a person does that with one tap.
 *
 * A suggestion is a stated reason, never a score: a rule, or the free bin nearest
 * stock of the same type, then the same brand, then the first free bin. Nothing
 * here knows how often an item is taken, so nothing claims to be the "fastest" spot.
 */

export type MapItem = Pick<StockItem, "id" | "name" | "brand" | "variant" | "colourFinish" | "manufacturerCode" | "location" | "archivedAt"> & Pick<Partial<StockItem>, "category">;

export interface ShelfMap<T> {
  /** by binKey */
  bins: Map<string, T[]>;
  /** a location, but not a bin on the map ("Shelf A2", or a rack since renamed) */
  loose: T[];
  /** no location at all */
  unplaced: T[];
}

export function shelfMap<T extends Pick<StockItem, "location" | "archivedAt">>(items: readonly T[], matrix: LocationMatrix | null | undefined): ShelfMap<T> {
  const out: ShelfMap<T> = { bins: new Map(), loose: [], unplaced: [] };
  for (const item of items) {
    if (item.archivedAt) continue;
    if (!item.location?.trim()) {
      out.unplaced.push(item);
      continue;
    }
    const at = binAt(item.location, matrix);
    if (!at) {
      out.loose.push(item);
      continue;
    }
    const key = binKey(at.rack.id, at.shelf, at.bin);
    const here = out.bins.get(key);
    if (here) here.push(item);
    else out.bins.set(key, [item]);
  }
  return out;
}

export interface BinSuggestion {
  location: string;
  rackId: string;
  shelf: number;
  bin: number;
  why: string;
}

export interface SuggestFor {
  /** left out of what's already in the bins, so an item can be re-placed */
  id?: string;
  text: string;
  category?: string | null;
  brand?: string | null;
}

/** A free bin holds no stock and no rule says it's for something else. */
function freeBins(matrix: LocationMatrix, rack: MatrixRack, shelf: number, taken: ReadonlySet<string>): number[] {
  const out: number[] = [];
  for (let bin = 1; bin <= rack.bins; bin += 1) {
    if (!taken.has(binKey(rack.id, shelf, bin)) && !matrix.rules.some((r) => r.rackId === rack.id && r.shelf === shelf && r.bin === bin)) out.push(bin);
  }
  return out;
}

function nearest(to: readonly number[], from: readonly number[]): number {
  const distance = (n: number) => Math.min(...to.map((t) => Math.abs(t - n)));
  return [...from].sort((a, b) => distance(a) - distance(b) || a - b)[0]!;
}

function besideThe(peers: ReadonlyArray<{ rack: MatrixRack; shelf: number; bin: number }>, label: string, matrix: LocationMatrix, taken: ReadonlySet<string>): BinSuggestion | null {
  const shelves = new Map<string, { rack: MatrixRack; shelf: number; bins: number[] }>();
  for (const p of peers) {
    const key = `${p.rack.id}:${p.shelf}`;
    const s = shelves.get(key);
    if (s) s.bins.push(p.bin);
    else shelves.set(key, { rack: p.rack, shelf: p.shelf, bins: [p.bin] });
  }
  const ranked = [...shelves.values()].sort((a, b) => b.bins.length - a.bins.length);
  for (const s of ranked) {
    const free = freeBins(matrix, s.rack, s.shelf, taken);
    if (!free.length) continue;
    const bin = nearest(s.bins, free);
    return { location: locationText(s.rack, s.shelf, bin), rackId: s.rack.id, shelf: s.shelf, bin, why: `With ${label}: ${s.bins.length} already on ${rackLabel(s.rack.name)} Shelf ${shelfLabel(s.shelf)}` };
  }
  // Those shelves are full: the closest shelf on the same rack.
  const top = ranked[0];
  if (!top) return null;
  const others = Array.from({ length: top.rack.shelves }, (_, i) => i + 1).filter((n) => n !== top.shelf).sort((a, b) => Math.abs(a - top.shelf) - Math.abs(b - top.shelf) || a - b);
  for (const shelf of others) {
    const free = freeBins(matrix, top.rack, shelf, taken);
    if (free.length) return { location: locationText(top.rack, shelf, free[0]!), rackId: top.rack.id, shelf, bin: free[0]!, why: `With ${label}: Shelf ${shelfLabel(top.shelf)} of ${rackLabel(top.rack.name)} is full, this is the closest free bin` };
  }
  return null;
}

/** The one place this should go, with the reason, or null when the map has no room or no racks. */
export function suggestBin(target: SuggestFor, matrix: LocationMatrix | null | undefined, items: readonly MapItem[]): BinSuggestion | null {
  if (!matrix?.racks.length) return null;
  const rule = ruleFor(target.text, matrix);
  if (rule) return { location: rule.location, rackId: rule.rack.id, shelf: rule.rule.shelf, bin: rule.rule.bin, why: `Rule: “${rule.rule.words}” goes here` };

  const others = items.filter((i) => i.id !== target.id);
  const map = shelfMap(others, matrix);
  const taken = new Set(map.bins.keys());
  const placed = others.flatMap((item) => {
    const at = item.archivedAt ? null : binAt(item.location, matrix);
    return at ? [{ item, ...at }] : [];
  });

  const type = target.category ? typeOf(target.category) : null;
  if (type && type !== OTHER_TYPE) {
    const found = besideThe(placed.filter((p) => p.item.category === target.category), type.label, matrix, taken);
    if (found) return found;
  }
  const brand = target.brand?.trim().toLowerCase();
  if (brand) {
    const found = besideThe(placed.filter((p) => p.item.brand?.trim().toLowerCase() === brand), target.brand!.trim(), matrix, taken);
    if (found) return found;
  }
  for (const rack of matrix.racks) {
    for (let shelf = 1; shelf <= rack.shelves; shelf += 1) {
      const free = freeBins(matrix, rack, shelf, taken);
      if (free.length) return { location: locationText(rack, shelf, free[0]!), rackId: rack.id, shelf, bin: free[0]!, why: "First free bin" };
    }
  }
  return null;
}

export interface PlacementIssue<T> {
  item: T;
  problem: string;
  suggestion: BinSuggestion | null;
}

/** Stock the map says needs a place: none recorded, not a bin, or in a different bin from its rule. */
export function placementIssues<T extends MapItem>(items: readonly T[], matrix: LocationMatrix | null | undefined): Array<PlacementIssue<T>> {
  if (!matrix?.racks.length) return [];
  const map = shelfMap(items, matrix);
  const suggest = (item: T) => suggestBin({ id: item.id, text: itemWords(item), category: item.category, brand: item.brand }, matrix, items);
  const byName = (a: PlacementIssue<T>, b: PlacementIssue<T>) => a.item.name.localeCompare(b.item.name, "en-AU", { numeric: true, sensitivity: "base" });
  const misplaced: Array<PlacementIssue<T>> = [];
  for (const here of map.bins.values()) {
    for (const item of here) {
      const rule = ruleFor(itemWords(item), matrix);
      if (rule && rule.location.toLowerCase() !== item.location?.trim().toLowerCase()) misplaced.push({ item, problem: `In ${item.location}, but its rule says another bin`, suggestion: suggest(item) });
    }
  }
  return [
    ...map.unplaced.map((item) => ({ item, problem: "No location recorded", suggestion: suggest(item) })).sort(byName),
    ...map.loose.map((item) => ({ item, problem: `“${item.location}” isn't a bin on the map`, suggestion: suggest(item) })).sort(byName),
    ...misplaced.sort(byName),
  ];
}
