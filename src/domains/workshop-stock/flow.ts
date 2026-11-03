import { formatQuantity, stepMilli, UNIT_LABEL } from "./format";
import type { CandidateItem, MatchCandidate, ReadPhotoResult, ReadProduct, StockUnit } from "./schema";

/**
 * Workshop Stock — pure decisions behind the add/take screens (unit-tested
 * without a DOM). Nothing here talks to the network or writes stock.
 */

/**
 * The freshest copy of an item the screen holds — the list's, or the one a
 * photo read returned moments ago (each carries the ledger version it was read
 * at). The confirm screen re-reads it anyway; this just starts from the best.
 */
export function freshestItem<T extends { version: number }>(listed: T | null | undefined, other: T): T {
  return listed && listed.version >= other.version ? listed : other;
}

/** −/+ by one unit step, never below `min`. */
export function stepQuantity(milli: number, unit: StockUnit, dir: 1 | -1, min = 0): number {
  const step = stepMilli(unit);
  const next = milli + dir * step;
  return Math.max(min, Math.round(next / step) * step);
}

/** A sensible name from what the photo shows — the worker can change it. */
export function suggestName(p: Pick<ReadProduct, "brand" | "description" | "colourFinish" | "variantDetails" | "manufacturerCode"> | null | undefined): string {
  if (!p) return "";
  const base = [p.brand, p.description].filter(Boolean).join(" ").trim() || (p.manufacturerCode ?? "");
  const variant = [p.colourFinish, ...(p.variantDetails || []).slice(0, 2)].filter(Boolean).join(" ");
  const name = variant && !base.toLowerCase().includes(variant.toLowerCase()) ? `${base} — ${variant}` : base;
  return name.slice(0, 160);
}

/**
 * What a loose item looks like, as a starting name — only when NOTHING was
 * printed to name it (2026-11-03). "white 2 gang switch plate" → "White 2 gang
 * switch plate". A person checks it; it is never matched on.
 */
export function looksName(p: Pick<ReadProduct, "brand" | "description" | "colourFinish" | "variantDetails" | "manufacturerCode" | "appearance"> | null | undefined): string | null {
  if (!p || suggestName(p) || !p.appearance) return null;
  const a = p.appearance.trim();
  return a ? (a[0]!.toUpperCase() + a.slice(1)).slice(0, 160) : null;
}

/** The printed pack quantity, offered (never applied) as a pack conversion. */
export function packSuggestion(p: Pick<ReadProduct, "packQuantity" | "packUnit"> | null | undefined, unit: StockUnit): { sizeMilli: number; label: string } | null {
  if (!p || !p.packQuantity || p.packQuantity < 2) return null;
  const counts = p.packUnit === "each" ? "each" : p.packUnit === "metre" ? "metre" : null;
  if (counts !== unit) return null;
  const sizeMilli = p.packQuantity * 1000;
  return { sizeMilli, label: `The label says ${formatQuantity(sizeMilli, unit)} per pack` };
}

/** What the read result means for the screen, in one decision. */
export type ReadOutcome =
  | { kind: "status"; status: Exclude<ReadPhotoResult["readStatus"], "ok"> }
  | { kind: "pick-product"; products: ReadProduct[] }
  | { kind: "exact"; productIndex: number; candidate: MatchCandidate; item: CandidateItem }
  | { kind: "candidates"; productIndex: number; candidates: Array<{ candidate: MatchCandidate; item: CandidateItem }> }
  | { kind: "none"; productIndex: number };

export function decideRead(result: ReadPhotoResult, chosenProduct: number | null): ReadOutcome {
  if (result.readStatus !== "ok" || !result.reading || !result.reading.products.length) {
    return { kind: "status", status: result.readStatus === "ok" ? "unreadable" : result.readStatus };
  }
  const products = result.reading.products;
  if (products.length > 1 && chosenProduct === null) return { kind: "pick-product", products };
  const index = chosenProduct ?? 0;
  const match = result.matches.find((m) => m.productIndex === index);
  if (!match || match.outcome === "none" || !match.candidates.length) return { kind: "none", productIndex: index };
  const byId = new Map(result.candidateItems.map((i) => [i.id, i]));
  const rows = match.candidates.map((c) => ({ candidate: c, item: byId.get(c.itemId) })).filter((r): r is { candidate: MatchCandidate; item: CandidateItem } => Boolean(r.item));
  if (!rows.length) return { kind: "none", productIndex: index };
  if (match.outcome === "exact" && rows[0]) return { kind: "exact", productIndex: index, candidate: rows[0].candidate, item: rows[0].item };
  return { kind: "candidates", productIndex: index, candidates: rows };
}

/** How a product read from the photo is described on a "which one?" button. */
export function productLabel(p: ReadProduct, i: number): string {
  const what = [p.brand, p.description || p.manufacturerCode].filter(Boolean).join(" ") || (p.appearance ? `Looks like ${p.appearance}` : `Product ${i + 1}`);
  return p.position ? `${what} (${p.position})` : what;
}

/** Whole-unit text input mode (numeric keypad) vs decimal (metres). */
export function inputModeFor(unit: StockUnit): "numeric" | "decimal" {
  return UNIT_LABEL[unit].decimals > 0 ? "decimal" : "numeric";
}

/**
 * Adding several products from ONE photo, one at a time (owner pull,
 * 2026-11-01: "take one photo of multiple items and be able to add them").
 * Pure progress through the photo's products: which one is on screen, which
 * were added and which skipped. Nothing here saves anything — each product
 * still goes through its own confirmation.
 */
export interface PhotoBatch {
  total: number;
  /** the product index on screen; -1 once every product is settled */
  current: number;
  added: number[];
  skipped: number[];
}

export function startBatch(total: number): PhotoBatch {
  return { total: Math.max(0, total), current: total > 0 ? 0 : -1, added: [], skipped: [] };
}

/** Jump to a product the worker tapped (an unsettled one, or one to revisit). */
export function focusBatch(b: PhotoBatch, index: number): PhotoBatch {
  return index >= 0 && index < b.total ? { ...b, current: index } : b;
}

/**
 * The product on screen was added or skipped: record it, and move to the next
 * product not yet settled (after it first, then any earlier one passed over).
 * `next` is null when every product is settled.
 */
export function settleBatch(b: PhotoBatch, how: "added" | "skipped"): { batch: PhotoBatch; next: number | null } {
  if (b.current < 0) return { batch: b, next: null };
  const i = b.current;
  const added = how === "added" ? [...b.added.filter((x) => x !== i), i] : b.added.filter((x) => x !== i);
  const skipped = how === "skipped" ? [...b.skipped.filter((x) => x !== i), i] : b.skipped.filter((x) => x !== i);
  const settled = new Set([...added, ...skipped]);
  const order = [...Array.from({ length: b.total }, (_, k) => k).filter((k) => k > i), ...Array.from({ length: i }, (_, k) => k)];
  const next = order.find((k) => !settled.has(k)) ?? null;
  return { batch: { ...b, added, skipped, current: next ?? -1 }, next };
}
