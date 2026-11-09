import type { StockItem } from "./schema";
import { identityLine } from "./format";
import { splitLocation } from "./location";

/**
 * Workshop Stock — the office catalogue view (/stock): the order the cards are
 * read in and the short lines on each card. Pure.
 *
 * Owner pull, 2026-11-09: "i want the web view of the workshop stock to feel
 * like an online store catalog". The cards only rearrange facts the list
 * already has — no prices, ratings or stock levels the record doesn't hold
 * (P7): a quantity is still "recorded", a missing photo is still a package.
 */

export const CATALOG_SORTS = [
  { value: "name", label: "Name A–Z" },
  { value: "shelf", label: "Shelf order" },
  { value: "moved", label: "Recently moved" },
  { value: "added", label: "Newest first" },
] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number]["value"];

export function isCatalogSort(v: unknown): v is CatalogSort {
  return CATALOG_SORTS.some((s) => s.value === v);
}

const natural = (a: string, b: string) =>
  a.localeCompare(b, "en-AU", { numeric: true, sensitivity: "base" });
/** newest first; never-moved / unknown dates last */
const newest = (a: string | null, b: string | null) =>
  a && b ? b.localeCompare(a) : a ? -1 : b ? 1 : 0;

type Sortable = Pick<StockItem, "name" | "location" | "lastMovementAt" | "createdAt">;

/** The items in the chosen order (a new array; ties fall back to the name). */
export function sortCatalog<T extends Sortable>(items: readonly T[], sort: CatalogSort): T[] {
  const byName = (a: T, b: T) => natural(a.name, b.name);
  const out = [...items];
  if (sort === "name") return out.sort(byName);
  if (sort === "moved")
    return out.sort((a, b) => newest(a.lastMovementAt, b.lastMovementAt) || byName(a, b));
  if (sort === "added") return out.sort((a, b) => newest(a.createdAt, b.createdAt) || byName(a, b));
  // shelf: located items in natural location order, the unlocated last
  return out.sort((a, b) => {
    const la = a.location?.trim() || null;
    const lb = b.location?.trim() || null;
    if (la && lb) return natural(la, lb) || byName(a, b);
    if (la) return -1;
    if (lb) return 1;
    return byName(a, b);
  });
}

/**
 * The line under a card's name: the item's identity without the brand, which
 * the card already shows above the name ("Iconic · Switch · 2 gang · White ·
 * 3042WE").
 */
export function cardSpecLine(item: Parameters<typeof identityLine>[0]): string {
  const brand = item.brand?.trim().toLowerCase();
  return identityLine(item)
    .split(" · ")
    .filter((p) => p && p.trim().toLowerCase() !== brand)
    .join(" · ");
}

/** Where it lives, short enough for a card: "Shelf A2 · Bin 4", or null when nothing is recorded. */
export function cardLocation(location: string | null | undefined): string | null {
  const { shelf, bin } = splitLocation(location);
  if (!shelf) return null;
  return bin ? `${shelf} · ${bin}` : shelf;
}
