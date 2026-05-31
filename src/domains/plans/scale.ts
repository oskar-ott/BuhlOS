/**
 * Per-page measurement for the Plan Viewer (bible: "no fake measurement").
 *
 * A length is only a real number once a page has been calibrated from a drawn
 * line of known real-world length, or explicitly declared approximate. With no
 * scale set, the viewer reports "scale not set" rather than inventing a number.
 *
 * Distances are computed in raster pixels (`width`/`height`), not normalised
 * units, so a non-square page measures consistently on both axes.
 */

import type { NormPoint } from "./coords";

export type LengthUnit = "mm" | "m";

export interface PageRaster {
  width: number;
  height: number;
}

export type ScaleState =
  | { kind: "unset" }
  | { kind: "calibrated"; unitsPerPixel: number; unit: LengthUnit }
  | { kind: "approximate"; unitsPerPixel: number; unit: LengthUnit };

export type MeasureResult =
  | { kind: "unset" }
  | {
      kind: "calibrated" | "approximate";
      length: number;
      unit: LengthUnit;
      label: string;
    };

const EPS = 1e-9;

/** Isotropic distance between two normalised points, in raster pixels. */
export function pageDistancePixels(
  a: NormPoint,
  b: NormPoint,
  raster: PageRaster,
): number {
  const dx = (b.nx - a.nx) * raster.width;
  const dy = (b.ny - a.ny) * raster.height;
  return Math.hypot(dx, dy);
}

/** Calibrate from a drawn line of known real length; refuses degenerate input. */
export function calibrateFromLine(
  a: NormPoint,
  b: NormPoint,
  raster: PageRaster,
  knownLength: number,
  unit: LengthUnit,
): ScaleState {
  const px = pageDistancePixels(a, b, raster);
  if (px <= EPS || !(knownLength > 0)) return { kind: "unset" };
  return { kind: "calibrated", unitsPerPixel: knownLength / px, unit };
}

/** A scale that is known only approximately (e.g. declared, not calibrated). */
export function approximateScale(
  unitsPerPixel: number,
  unit: LengthUnit,
): ScaleState {
  if (!(unitsPerPixel > 0)) return { kind: "unset" };
  return { kind: "approximate", unitsPerPixel, unit };
}

/** Measure a line under a scale; honestly returns "unset" when no scale exists. */
export function measureLine(
  a: NormPoint,
  b: NormPoint,
  raster: PageRaster,
  scale: ScaleState,
): MeasureResult {
  if (scale.kind === "unset") return { kind: "unset" };
  const length = pageDistancePixels(a, b, raster) * scale.unitsPerPixel;
  const formatted = formatLength(length, scale.unit);
  return {
    kind: scale.kind,
    length,
    unit: scale.unit,
    label: scale.kind === "approximate" ? `~ ${formatted}` : formatted,
  };
}

/** Display a length: metres to 2dp, millimetres as whole units. */
export function formatLength(length: number, unit: LengthUnit): string {
  return unit === "mm" ? `${Math.round(length)} mm` : `${length.toFixed(2)} m`;
}

/** Human label for the page's measurement state (drives the honesty badge). */
export function scaleStateLabel(scale: ScaleState): string {
  switch (scale.kind) {
    case "calibrated":
      return "Calibrated";
    case "approximate":
      return "Approximate";
    default:
      return "Scale not set";
  }
}
