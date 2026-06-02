import { describe, expect, it } from "vitest";
import {
  approximateScale,
  calibrateFromLine,
  formatLength,
  measureLine,
  pageDistancePixels,
  scaleStateLabel,
  type ScaleState,
} from "./scale";

/* ----------------------------------------------------------------------
 * Per-page measurement (Plan Viewer bible: "no fake measurement —
 * calibrated vs approximate vs scale-not-set"). A measurement is only ever
 * a real number when the page has been calibrated (or explicitly declared
 * approximate); otherwise the viewer must say the scale is not set rather
 * than invent a length. Distances are isotropic in raster pixels so a
 * non-square page measures correctly on both axes.
 * -------------------------------------------------------------------- */

const raster = { width: 1000, height: 800 };

describe("pageDistancePixels", () => {
  it("measures in raster pixels, not normalised units (anisotropy-safe)", () => {
    // Full-width line spans the raster width.
    expect(pageDistancePixels({ nx: 0, ny: 0.5 }, { nx: 1, ny: 0.5 }, raster)).toBeCloseTo(1000, 9);
    // Full-height line spans the raster height, even though both are "1.0"
    // in normalised space.
    expect(pageDistancePixels({ nx: 0.5, ny: 0 }, { nx: 0.5, ny: 1 }, raster)).toBeCloseTo(800, 9);
    // Diagonal.
    expect(pageDistancePixels({ nx: 0, ny: 0 }, { nx: 1, ny: 1 }, raster)).toBeCloseTo(Math.hypot(1000, 800), 9);
  });

  it("is zero for a degenerate (single-point) line", () => {
    expect(pageDistancePixels({ nx: 0.3, ny: 0.3 }, { nx: 0.3, ny: 0.3 }, raster)).toBe(0);
  });
});

describe("calibrateFromLine", () => {
  it("derives units-per-pixel from a drawn line of known length", () => {
    // 1000px horizontal line declared as 10 m -> 0.01 m/px.
    const s = calibrateFromLine({ nx: 0, ny: 0.5 }, { nx: 1, ny: 0.5 }, raster, 10, "m");
    expect(s.kind).toBe("calibrated");
    if (s.kind !== "unset") {
      expect(s.unitsPerPixel).toBeCloseTo(0.01, 9);
      expect(s.unit).toBe("m");
    }
  });

  it("refuses to calibrate from a zero-length line or non-positive length", () => {
    expect(calibrateFromLine({ nx: 0.2, ny: 0.2 }, { nx: 0.2, ny: 0.2 }, raster, 10, "m").kind).toBe("unset");
    expect(calibrateFromLine({ nx: 0, ny: 0 }, { nx: 1, ny: 1 }, raster, 0, "m").kind).toBe("unset");
    expect(calibrateFromLine({ nx: 0, ny: 0 }, { nx: 1, ny: 1 }, raster, -5, "m").kind).toBe("unset");
  });
});

describe("measureLine", () => {
  const calibrated = calibrateFromLine({ nx: 0, ny: 0.5 }, { nx: 1, ny: 0.5 }, raster, 10, "m");

  it("returns a real length once calibrated, consistent across axes", () => {
    // Page is 10 m wide; the 1000:800 raster makes it 8 m tall.
    const vertical = measureLine({ nx: 0.5, ny: 0 }, { nx: 0.5, ny: 1 }, raster, calibrated);
    expect(vertical.kind).toBe("calibrated");
    if (vertical.kind !== "unset") {
      expect(vertical.length).toBeCloseTo(8, 9);
      expect(vertical.unit).toBe("m");
      expect(vertical.label).toBe("8.00 m");
    }
  });

  it("NEVER invents a length when the scale is unset", () => {
    const unset: ScaleState = { kind: "unset" };
    const r = measureLine({ nx: 0, ny: 0 }, { nx: 1, ny: 1 }, raster, unset);
    expect(r.kind).toBe("unset");
    expect(r).not.toHaveProperty("length");
  });

  it("flags an approximate scale's result as approximate (prefixed ~)", () => {
    const approx = approximateScale(0.02, "m"); // 0.02 m/px
    const r = measureLine({ nx: 0, ny: 0.5 }, { nx: 1, ny: 0.5 }, raster, approx); // 1000px
    expect(r.kind).toBe("approximate");
    if (r.kind !== "unset") {
      expect(r.length).toBeCloseTo(20, 9);
      expect(r.label).toBe("~ 20.00 m");
    }
  });
});

describe("formatLength", () => {
  it("formats metres to 2dp and millimetres as whole units", () => {
    expect(formatLength(2.5, "m")).toBe("2.50 m");
    expect(formatLength(0.5, "m")).toBe("0.50 m");
    expect(formatLength(1500, "mm")).toBe("1500 mm");
    expect(formatLength(1499.6, "mm")).toBe("1500 mm");
  });
});

describe("scaleStateLabel", () => {
  it("describes the three honest measurement states", () => {
    expect(scaleStateLabel({ kind: "unset" })).toBe("Scale not set");
    expect(scaleStateLabel(approximateScale(0.02, "m"))).toBe("Approximate");
    expect(scaleStateLabel(calibrateFromLine({ nx: 0, ny: 0 }, { nx: 1, ny: 0 }, raster, 5, "m"))).toBe("Calibrated");
  });
});
