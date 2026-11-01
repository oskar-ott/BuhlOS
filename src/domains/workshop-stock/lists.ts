import { formatQuantity, identityLine } from "./format";
import { splitLocation } from "./location";
import type { ListLine, ShoppingList, StockItem, StockUnit } from "./schema";

/**
 * Workshop Stock — shopping lists, read against what's recorded. Pure.
 *
 * Owner pull 2026-11-01: "On a job or in the workshop, see what we need to get
 * from the wholesaler and what we have in the workshop — a list they can go
 * back to and use to go through and find everything."
 *
 * A list is a plan; the sections are a VIEW over its lines and today's
 * recorded stock, worked out fresh every time:
 *
 *   In the workshop       a workshop item with stock recorded — in SHELF order,
 *                         so collecting is one walk round the workshop
 *   Get from the wholesaler   anything we don't stock (a text line), an item
 *                         with none recorded, or the rest of an item that is
 *                         short ("we have 2 of the 6")
 *   Got                   ticked — by the take that collected it, or by hand
 *
 * Recorded stock is what's been logged, not a promise of what's on the shelf
 * (P7): a line says "6 each recorded", never "in stock".
 */

export type LineState = "workshop" | "short" | "wholesaler" | "got";

export interface LineView {
  line: ListLine;
  /** the live workshop item, when the line is one (null: text line, archived or gone) */
  item: StockItem | null;
  /** what to call it: the item's name, or the text */
  title: string;
  /** brand · range · gang … for an item */
  detail: string;
  unit: StockUnit;
  neededMilli: number | null;
  recordedMilli: number | null;
  /** short: how many more to get from the wholesaler */
  shortMilli: number;
  state: LineState;
}

export interface ListView {
  workshop: LineView[];
  wholesaler: LineView[];
  got: LineView[];
  total: number;
  gotCount: number;
}

const natural = (a: string, b: string) => a.localeCompare(b, "en-AU", { numeric: true, sensitivity: "base" });

export function viewLine(line: ListLine, byId: ReadonlyMap<string, StockItem>): LineView {
  const item = line.itemId ? byId.get(line.itemId) ?? null : null;
  const live = item && !item.archivedAt ? item : null;
  const unit = (live?.baseUnit ?? (line.itemUnit as StockUnit | null) ?? line.unit ?? "each") as StockUnit;
  const title = live?.name ?? line.itemName ?? line.text ?? "Something";
  const detail = live ? identityLine(live) : line.itemId ? (line.itemArchived || item?.archivedAt ? "No longer stocked in the workshop" : "Not in the workshop list") : "";
  const needed = line.quantityMilli;
  const recorded = live ? live.balanceMilli : null;
  let state: LineState;
  let shortMilli = 0;
  if (line.gotAt) state = "got";
  else if (!live || recorded === 0) state = "wholesaler";
  else if (needed !== null && recorded !== null && recorded < needed) {
    state = "short";
    shortMilli = needed - recorded;
  } else state = "workshop";
  return { line, item: live, title, detail, unit, neededMilli: needed, recordedMilli: recorded, shortMilli, state };
}

/** The list split into where each thing comes from. A short line is in both: take what's there, get the rest. */
export function viewList(list: Pick<ShoppingList, "lines">, items: readonly StockItem[]): ListView {
  const byId = new Map(items.map((i) => [i.id, i]));
  const views = list.lines.map((l) => viewLine(l, byId));
  const shelfOrder = (v: LineView) => {
    const { shelf, bin } = splitLocation(v.item?.location);
    return `${shelf ? `0 ${shelf}` : "1"} ${bin ?? ""} ${v.title}`;
  };
  const workshop = views.filter((v) => v.state === "workshop" || v.state === "short").sort((a, b) => natural(shelfOrder(a), shelfOrder(b)));
  const wholesaler = views.filter((v) => v.state === "wholesaler" || v.state === "short");
  const got = views.filter((v) => v.state === "got");
  return { workshop, wholesaler, got, total: views.length, gotCount: got.length };
}

/** "6 each", or null when no number was given. */
export function neededLabel(v: Pick<LineView, "neededMilli" | "unit">): string | null {
  return v.neededMilli === null ? null : formatQuantity(v.neededMilli, v.unit);
}

/** What to get from the wholesaler for this line: all of it, or the rest of a short one. */
export function wholesalerQuantity(v: LineView): string | null {
  if (v.state === "short") return formatQuantity(v.shortMilli, v.unit);
  return neededLabel(v);
}

/**
 * The wholesaler part as plain text — to read at the counter, or send by text
 * or email from the phone's share sheet. Codes are kept: they are what the
 * counter looks up.
 */
export function wholesalerText(list: Pick<ShoppingList, "name" | "jobLabel">, view: ListView): string {
  const head = [list.name, list.jobLabel].filter(Boolean).join(" — ");
  const rows = view.wholesaler.map((v) => {
    const qty = wholesalerQuantity(v);
    const code = v.item?.manufacturerCode ? ` (${v.item.manufacturerCode})` : "";
    const detail = v.item ? identityLine({ ...v.item, manufacturerCode: null }) : "";
    const what = v.item ? `${v.item.name}${code}${detail ? ` — ${detail}` : ""}` : v.title;
    return `- ${qty ? `${qty} × ` : ""}${what}${v.state === "short" ? ` (we have ${formatQuantity(v.recordedMilli ?? 0, v.unit)})` : ""}`;
  });
  return [head, ...rows].filter(Boolean).join("\n");
}

/** "5 to get · 2 got" — the one-line state of a list for a card. */
export function listSummary(view: ListView): string {
  const left = view.total - view.gotCount;
  if (!view.total) return "Nothing on it yet";
  if (!left) return `All ${view.total} got`;
  return `${left} to get${view.gotCount ? ` · ${view.gotCount} got` : ""}`;
}
