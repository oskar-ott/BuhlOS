import { isArchived, isCurrent, isSuperseded } from "@/domains/documents/format";
import type { Document } from "@/domains/documents/types";
import type { Plan, PlanPage } from "./types";

/**
 * Viewer-specific helpers for the plans domain — a read-only view layer over
 * the documents register. Status/title/grouping helpers are reused from
 * `@/domains/documents/format`; this module adds only what the viewer needs:
 * typed page extraction, raster-vs-fallback, current-revision selection
 * (Phil sees current only), and the superseded guard.
 */

/** Extract a typed, ascending-by-pageIndex page list from a register row. */
export function planPages(doc: Document): PlanPage[] {
  const raw = (doc as { pages?: unknown }).pages;
  if (!Array.isArray(raw)) return [];
  const pages: PlanPage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const pageIndex = typeof o.pageIndex === "number" ? o.pageIndex : Number.NaN;
    const pngUrl = typeof o.pngUrl === "string" ? o.pngUrl : "";
    if (!Number.isFinite(pageIndex) || !pngUrl) continue; // skip unrenderable
    pages.push({
      pageIndex,
      pngUrl,
      width: typeof o.width === "number" ? o.width : undefined,
      height: typeof o.height === "number" ? o.height : undefined,
      sizeBytes: typeof o.sizeBytes === "number" ? o.sizeBytes : undefined,
      sha256: typeof o.sha256 === "string" ? o.sha256 : undefined,
    });
  }
  pages.sort((a, b) => a.pageIndex - b.pageIndex);
  return pages;
}

/** True when the plan has at least one renderable raster page. */
export function hasRaster(doc: Document): boolean {
  return planPages(doc).length > 0;
}

/** Number of renderable raster pages. */
export function pageCount(doc: Document): number {
  return planPages(doc).length;
}

/** The first page to show (lowest pageIndex), or null when not rasterised. */
export function defaultPage(doc: Document): PlanPage | null {
  return planPages(doc)[0] ?? null;
}

/** Decorate a register row with its typed pages for the viewer. */
export function toPlan(doc: Document): Plan {
  return { ...doc, pages: planPages(doc) };
}

/** Current (and legacy no-status) revisions only — the set Phil may see. */
export function currentPlans(docs: ReadonlyArray<Document>): Document[] {
  return docs.filter((d) => isCurrent(d));
}

/** Everything an admin/LH can open: current + superseded, never archived. */
export function viewablePlans(docs: ReadonlyArray<Document>): Document[] {
  return docs.filter((d) => !isArchived(d));
}

/** Look up a single plan by id. */
export function findPlan(
  docs: ReadonlyArray<Document>,
  planId: string,
): Document | null {
  return docs.find((d) => d.id === planId) ?? null;
}

/** Superseded guard: true only for an existing, superseded revision. */
export function isSupersededId(
  docs: ReadonlyArray<Document>,
  planId: string,
): boolean {
  const doc = findPlan(docs, planId);
  return doc ? isSuperseded(doc) : false;
}
