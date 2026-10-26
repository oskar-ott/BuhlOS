/**
 * Workshop Stock — where an item lives, split into the SHELF (the group a list
 * is read by) and the BIN (the row's detail). Pure.
 *
 * Locations are free text the crew typed: "Shelf A2, Bin 4", "Breaker drawer",
 * "Cable bay", "Rack C / slot 3". The first separator (a comma, a slash, a
 * middle dot or a dash with spaces) splits shelf from bin; no separator means
 * the whole text is the shelf. Nothing is rewritten — the text is only read.
 */

export interface SplitLocation {
  shelf: string | null;
  bin: string | null;
}

const SEPARATOR = /\s*(?:,|\/|·|\s[-–—]\s)\s*/;

export function splitLocation(location: string | null | undefined): SplitLocation {
  const text = String(location ?? "").replace(/\s+/g, " ").trim();
  if (!text) return { shelf: null, bin: null };
  const at = text.search(SEPARATOR);
  if (at <= 0) return { shelf: text, bin: null };
  const sep = SEPARATOR.exec(text.slice(at))?.[0] ?? "";
  const shelf = text.slice(0, at).trim();
  const bin = text.slice(at + sep.length).trim();
  return { shelf: shelf || null, bin: bin || null };
}

export const NO_SHELF_LABEL = "No shelf set";

export interface ShelfGroup<T> {
  /** null = no location recorded (always the last group) */
  shelf: string | null;
  label: string;
  items: T[];
}

/**
 * The list grouped by shelf, shelves in natural order ("Shelf A2" before
 * "Shelf A10"), items by name within a shelf, the unlocated last. Shelves
 * compare case-insensitively so "shelf a2" and "Shelf A2" are one group (shown
 * under the spelling seen first).
 */
export function groupByShelf<T extends { name: string; location: string | null }>(items: readonly T[]): Array<ShelfGroup<T>> {
  const groups = new Map<string, ShelfGroup<T>>();
  const none: T[] = [];
  for (const item of items) {
    const { shelf } = splitLocation(item.location);
    if (!shelf) {
      none.push(item);
      continue;
    }
    const key = shelf.toLowerCase();
    const g = groups.get(key);
    if (g) g.items.push(item);
    else groups.set(key, { shelf, label: shelf, items: [item] });
  }
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, "en-AU", { numeric: true, sensitivity: "base" });
  const out = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, "en-AU", { numeric: true, sensitivity: "base" }));
  for (const g of out) g.items.sort(byName);
  if (none.length) out.push({ shelf: null, label: NO_SHELF_LABEL, items: none.sort(byName) });
  return out;
}

/** "Shelf A2, Bin 4" → "Bin 4" when the shelf is already the group header; null when there is no bin. */
export function binOf(location: string | null | undefined): string | null {
  return splitLocation(location).bin;
}
