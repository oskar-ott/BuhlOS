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
