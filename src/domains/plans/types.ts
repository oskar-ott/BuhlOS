import type { Document } from "@/domains/documents/types";

/**
 * View types for the Plan Viewer. The plan *data* is a documents-register
 * row (`Document` from api/plans.js); the plans domain adds the per-page
 * raster shape and a decorated `Plan` for the viewer.
 *
 * `width`/`height` are optional: api/plans.js `set-pages` persists only
 * `{ pageIndex, pngUrl, sha256, sizeBytes }`, so the raster's intrinsic
 * pixel size is read from the loaded <img> at runtime when absent.
 */
export interface PlanPage {
  pageIndex: number;
  pngUrl: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  sha256?: string;
}

export type Plan = Document & { pages: PlanPage[] };
