import { formatQuantity, stepMilli, UNIT_LABEL } from "./format";
import type { CandidateItem, MatchCandidate, ReadPhotoResult, ReadProduct, StockUnit } from "./schema";

/**
 * Workshop Stock — pure decisions behind the add/take screens (unit-tested
 * without a DOM). Nothing here talks to the network or writes stock.
 */

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
  const what = [p.brand, p.description || p.manufacturerCode].filter(Boolean).join(" ") || `Product ${i + 1}`;
  return p.position ? `${what} (${p.position})` : what;
}

/** Whole-unit text input mode (numeric keypad) vs decimal (metres). */
export function inputModeFor(unit: StockUnit): "numeric" | "decimal" {
  return UNIT_LABEL[unit].decimals > 0 ? "decimal" : "numeric";
}
