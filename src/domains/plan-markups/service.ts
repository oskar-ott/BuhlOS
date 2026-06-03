import { clamp01, type NormPoint } from "@/domains/plans/coords";
import type { DrawingMarkup, MarkupPoint } from "./types";

/**
 * Pure, DOM-free helpers for plan markups: page scoping, Phil-visibility
 * filtering, and conversion to the normalised points the renderer + coords.ts
 * consume. These mirror the authoritative filters in api/plan-markups.js (CJS)
 * so the client and server agree; both are tested.
 */

/** Non-archived markups for one page of one plan. The office-side baseline. */
export function activeMarkupsForPage(
  markups: ReadonlyArray<DrawingMarkup>,
  planId: string,
  pageIndex: number,
): DrawingMarkup[] {
  return markups.filter(
    (m) => !m.archived && m.planId === planId && m.pageIndex === pageIndex,
  );
}

/**
 * What a field worker may see: non-archived AND visibleToPhil, for this page.
 * The single source of truth for the Phil read-only filter — defence-in-depth
 * on top of the API's own filter.
 */
export function philMarkupsForPage(
  markups: ReadonlyArray<DrawingMarkup>,
  planId: string,
  pageIndex: number,
): DrawingMarkup[] {
  return activeMarkupsForPage(markups, planId, pageIndex).filter((m) => m.visibleToPhil);
}

/** Count summary for the BuhlOS overlay indicator. */
export interface MarkupCounts {
  total: number;
  visibleToPhil: number;
  officeOnly: number;
}
export function summariseMarkups(markups: ReadonlyArray<DrawingMarkup>): MarkupCounts {
  let visible = 0;
  for (const m of markups) if (m.visibleToPhil) visible += 1;
  return {
    total: markups.length,
    visibleToPhil: visible,
    officeOnly: markups.length - visible,
  };
}

/** Convert a stored {x,y} markup point to a coords.ts NormPoint, clamped 0..1. */
export function toNormPoint(p: MarkupPoint): NormPoint {
  return { nx: clamp01(p.x), ny: clamp01(p.y) };
}

/**
 * The ordered normalised points for any markup, in render order:
 *   pin/note → the single {x,y} anchor (if present)
 *   line/area → the `points` list
 * Always clamped into 0..1. Empty when the shape has no usable coordinates.
 */
export function markupNormPoints(m: Pick<DrawingMarkup, "type" | "x" | "y" | "points">): NormPoint[] {
  if (m.type === "pin" || m.type === "note") {
    if (typeof m.x === "number" && typeof m.y === "number") {
      return [toNormPoint({ x: m.x, y: m.y })];
    }
    return [];
  }
  return (m.points ?? []).map(toNormPoint);
}

/** The anchor point used to position a label / open the detail panel. */
export function markupAnchor(
  m: Pick<DrawingMarkup, "type" | "x" | "y" | "points">,
): NormPoint | null {
  const pts = markupNormPoints(m);
  if (pts.length === 0) return null;
  if (m.type === "pin" || m.type === "note" || m.type === "line") return pts[0]!;
  // area → centroid of its points (good enough for label placement)
  const sum = pts.reduce((acc, p) => ({ nx: acc.nx + p.nx, ny: acc.ny + p.ny }), { nx: 0, ny: 0 });
  return { nx: sum.nx / pts.length, ny: sum.ny / pts.length };
}
