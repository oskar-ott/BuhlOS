/**
 * Plan Viewer coordinate math (Plan Viewer bible, R-02).
 *
 * Every plan markup is stored in **normalised 0..1 page coordinates** (origin
 * top-left, x right, y down) so a mark stays anchored to the drawing regardless
 * of zoom, pan, screen size, or raster resolution. This module is the single
 * source of truth for mapping those normalised coordinates to/from on-screen
 * pixels, and for the 0..1 clamp invariant every stored coordinate must satisfy.
 * Pure logic, no DOM — unit-tested before any markup UI is built.
 */

export type Rotation = 0 | 90 | 180 | 270;

/** A point on the page in normalised 0..1 coordinates. */
export interface NormPoint {
  nx: number;
  ny: number;
}

/** A point in rendered viewport pixels. */
export interface PixelPoint {
  px: number;
  py: number;
}

/**
 * How a page raster is laid out in the viewport.
 * `baseWidth`/`baseHeight` are the page's on-screen size at zoom 1, rotation 0.
 * `offsetX`/`offsetY` are the pan position of the (rotated) box's top-left.
 */
export interface PageView {
  baseWidth: number;
  baseHeight: number;
  zoom: number;
  rotation: Rotation;
  offsetX: number;
  offsetY: number;
}

const EPS = 1e-9;
const MIN_ZOOM = 0.01;

/** Clamp a scalar into 0..1; non-finite collapses to a valid bound, never NaN. */
export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return v === Number.POSITIVE_INFINITY ? 1 : 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Force both axes of a point into 0..1 — the stored-coordinate invariant. */
export function clampNorm(p: NormPoint): NormPoint {
  return { nx: clamp01(p.nx), ny: clamp01(p.ny) };
}

/** True when both axes already lie within 0..1 (optionally within `eps`). */
export function isNormalised(p: NormPoint, eps = 0): boolean {
  return p.nx >= -eps && p.nx <= 1 + eps && p.ny >= -eps && p.ny <= 1 + eps;
}

/** On-screen size of the page box after zoom + rotation (90/270 swap axes). */
export function rotatedSize(
  baseWidth: number,
  baseHeight: number,
  zoom: number,
  rotation: Rotation,
): { width: number; height: number } {
  const w = baseWidth * zoom;
  const h = baseHeight * zoom;
  return rotation === 90 || rotation === 270
    ? { width: h, height: w }
    : { width: w, height: h };
}

/** Normalised page point -> viewport pixel. */
export function normToPixel(p: NormPoint, view: PageView): PixelPoint {
  const w0 = view.baseWidth * view.zoom;
  const h0 = view.baseHeight * view.zoom;
  const lx = p.nx * w0;
  const ly = p.ny * h0;

  // Rotate the local page-pixel (lx,ly) clockwise into the rotated box.
  let rx: number;
  let ry: number;
  switch (view.rotation) {
    case 90:
      rx = h0 - ly;
      ry = lx;
      break;
    case 180:
      rx = w0 - lx;
      ry = h0 - ly;
      break;
    case 270:
      rx = ly;
      ry = w0 - lx;
      break;
    default:
      rx = lx;
      ry = ly;
      break;
  }
  return { px: view.offsetX + rx, py: view.offsetY + ry };
}

/** Viewport pixel -> normalised page point, always clamped into 0..1. */
export function pixelToNorm(p: PixelPoint, view: PageView): NormPoint {
  const w0 = Math.max(view.baseWidth * view.zoom, EPS);
  const h0 = Math.max(view.baseHeight * view.zoom, EPS);
  const rx = p.px - view.offsetX;
  const ry = p.py - view.offsetY;

  // Inverse of the rotation applied in normToPixel.
  let lx: number;
  let ly: number;
  switch (view.rotation) {
    case 90:
      lx = ry;
      ly = h0 - rx;
      break;
    case 180:
      lx = w0 - rx;
      ly = h0 - ry;
      break;
    case 270:
      lx = w0 - ry;
      ly = rx;
      break;
    default:
      lx = rx;
      ly = ry;
      break;
  }
  return clampNorm({ nx: lx / w0, ny: ly / h0 });
}

/** Zoom that fits the page to the viewport width, or the whole page. */
export function fitZoom(
  viewport: { width: number; height: number },
  base: { width: number; height: number },
  rotation: Rotation,
  mode: "width" | "page",
): number {
  const rotated = rotation === 90 || rotation === 270;
  const effW = Math.max(rotated ? base.height : base.width, EPS);
  const effH = Math.max(rotated ? base.width : base.height, EPS);
  const byWidth = Math.max(viewport.width, 0) / effW;
  const z =
    mode === "width"
      ? byWidth
      : Math.min(byWidth, Math.max(viewport.height, 0) / effH);
  return z > 0 && Number.isFinite(z) ? z : MIN_ZOOM;
}
