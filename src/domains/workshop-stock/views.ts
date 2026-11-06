/**
 * Workshop Stock — how the office list is grouped, for every view (table,
 * cards, shelf board). Pure: the same groups feed whichever view is chosen.
 *
 * - shelf: by the shelf part of the location (location.ts), unlocated last
 * - type:  by item type in catalogue order (types.ts), "Not sorted yet" last
 * - none:  one group, A–Z
 */
import { groupByShelf } from "./location";
import { NOT_SORTED_LABEL, STOCK_TYPES, typeOf } from "./types";

export const GROUP_BYS = ["shelf", "type", "none"] as const;
export type GroupBy = (typeof GROUP_BYS)[number];

export const VIEWS = ["table", "cards", "board"] as const;
export type StockView = (typeof VIEWS)[number];

export interface ItemGroup<T> {
  key: string;
  label: string;
  items: T[];
}

export const ALL_ITEMS_LABEL = "All items";

type Groupable = { name: string; location: string | null; category?: string | null };

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name, "en-AU", { numeric: true, sensitivity: "base" });

export function groupItems<T extends Groupable>(items: readonly T[], by: GroupBy): Array<ItemGroup<T>> {
  if (by === "shelf") return groupByShelf(items).map((g) => ({ key: `shelf:${g.shelf ?? ""}`, label: g.label, items: g.items }));
  if (by === "none") return items.length ? [{ key: "all", label: ALL_ITEMS_LABEL, items: [...items].sort(byName) }] : [];
  const by_ = new Map<string | null, T[]>();
  for (const i of items) {
    const k = i.category ? typeOf(i.category)!.key : null;
    by_.set(k, [...(by_.get(k) ?? []), i]);
  }
  const out: Array<ItemGroup<T>> = [];
  for (const t of STOCK_TYPES) {
    const list = by_.get(t.key);
    if (list?.length) out.push({ key: `type:${t.key}`, label: t.label, items: list.sort(byName) });
  }
  const none = by_.get(null);
  if (none?.length) out.push({ key: "type:", label: NOT_SORTED_LABEL, items: none.sort(byName) });
  return out;
}

export function isView(v: unknown): v is StockView {
  return typeof v === "string" && (VIEWS as readonly string[]).includes(v);
}
export function isGroupBy(v: unknown): v is GroupBy {
  return typeof v === "string" && (GROUP_BYS as readonly string[]).includes(v);
}

// ── sorting, within each group ───────────────────────────────────────────────

export const SORT_KEYS = ["name", "recorded", "moved", "counted"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export interface StockSort {
  key: SortKey;
  /** true = the key's natural order flipped (Z–A, highest first, …) */
  reversed: boolean;
}
export const DEFAULT_SORT: StockSort = { key: "name", reversed: false };

/**
 * Each key's natural order is the one the office reaches for:
 * name A–Z · recorded lowest first (what's running out) · moved most recent
 * first · counted longest ago first, never-counted at the top (a count round).
 */
export const SORT_LABEL: Record<SortKey, string> = {
  name: "Name A–Z",
  recorded: "Lowest recorded first",
  moved: "Last moved, newest first",
  counted: "Longest since counted",
};

type Sortable = { name: string; balanceMilli: number; lastMovementAt: string | null; lastCountedAt: string | null };

const time = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

function compare(a: Sortable, b: Sortable, key: SortKey): number {
  switch (key) {
    case "name":
      return byName(a, b);
    case "recorded":
      return a.balanceMilli - b.balanceMilli;
    case "moved": {
      // newest first; never moved last
      const ta = time(a.lastMovementAt), tb = time(b.lastMovementAt);
      if (ta === tb) return 0;
      if (ta === null) return 1;
      if (tb === null) return -1;
      return tb - ta;
    }
    case "counted": {
      // never counted first, then oldest count first
      const ta = time(a.lastCountedAt), tb = time(b.lastCountedAt);
      if (ta === tb) return 0;
      if (ta === null) return -1;
      if (tb === null) return 1;
      return ta - tb;
    }
  }
}

/** A sorted copy; ties fall back to the name so the order never jitters. */
export function sortItems<T extends Sortable>(items: readonly T[], sort: StockSort): T[] {
  const dir = sort.reversed ? -1 : 1;
  return [...items].sort((a, b) => dir * compare(a, b, sort.key) || byName(a, b));
}

export function sortGroups<T extends Sortable>(groups: ReadonlyArray<ItemGroup<T>>, sort: StockSort): Array<ItemGroup<T>> {
  return groups.map((g) => ({ ...g, items: sortItems(g.items, sort) }));
}

export function isSort(v: unknown): v is StockSort {
  const s = v as StockSort | null;
  return Boolean(s && typeof s === "object" && (SORT_KEYS as readonly string[]).includes(s.key) && typeof s.reversed === "boolean");
}

/** How many in a group have nothing recorded — shown beside the group's name. */
export function noneRecorded(items: ReadonlyArray<{ balanceMilli: number }>): number {
  return items.filter((i) => i.balanceMilli === 0).length;
}
