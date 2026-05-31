import { describe, expect, it } from "vitest";
import {
  clamp01,
  clampNorm,
  fitZoom,
  isNormalised,
  normToPixel,
  pixelToNorm,
  rotatedSize,
  type NormPoint,
  type PageView,
  type Rotation,
} from "./coords";

/* ----------------------------------------------------------------------
 * The whole markup/measure system stores marks in normalised 0..1 page
 * coordinates (Plan Viewer bible, R-02). This module is the single source
 * of truth for normalised <-> pixel mapping across zoom / pan / rotation,
 * and for the 0..1 clamp invariant. It is unit-tested before any markup UI.
 * -------------------------------------------------------------------- */

const ROTATIONS: Rotation[] = [0, 90, 180, 270];

/** A 1000x800 page rendered 1:1 at the origin (the simplest view). */
function baseView(overrides: Partial<PageView> = {}): PageView {
  return {
    baseWidth: 1000,
    baseHeight: 800,
    zoom: 1,
    rotation: 0,
    offsetX: 0,
    offsetY: 0,
    ...overrides,
  };
}

describe("clamp01", () => {
  it("clamps below 0 and above 1, leaves interior untouched", () => {
    expect(clamp01(-0.3)).toBe(0);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.42)).toBe(0.42);
    expect(clamp01(1)).toBe(1);
    expect(clamp01(1.7)).toBe(1);
  });

  it("maps non-finite input to 0 rather than propagating NaN", () => {
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clamp01(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe("clampNorm + isNormalised", () => {
  it("clampNorm forces both axes into 0..1", () => {
    expect(clampNorm({ nx: -0.1, ny: 1.4 })).toEqual({ nx: 0, ny: 1 });
    expect(clampNorm({ nx: 0.25, ny: 0.75 })).toEqual({ nx: 0.25, ny: 0.75 });
  });

  it("isNormalised is true only when both axes are within 0..1", () => {
    expect(isNormalised({ nx: 0, ny: 0 })).toBe(true);
    expect(isNormalised({ nx: 1, ny: 1 })).toBe(true);
    expect(isNormalised({ nx: 0.5, ny: 0.5 })).toBe(true);
    expect(isNormalised({ nx: -0.001, ny: 0.5 })).toBe(false);
    expect(isNormalised({ nx: 0.5, ny: 1.001 })).toBe(false);
  });
});

describe("rotatedSize", () => {
  it("keeps dimensions for 0 / 180 and swaps them for 90 / 270", () => {
    expect(rotatedSize(1000, 800, 1, 0)).toEqual({ width: 1000, height: 800 });
    expect(rotatedSize(1000, 800, 1, 180)).toEqual({ width: 1000, height: 800 });
    expect(rotatedSize(1000, 800, 1, 90)).toEqual({ width: 800, height: 1000 });
    expect(rotatedSize(1000, 800, 1, 270)).toEqual({ width: 800, height: 1000 });
  });

  it("scales the box by zoom", () => {
    expect(rotatedSize(1000, 800, 2, 0)).toEqual({ width: 2000, height: 1600 });
    expect(rotatedSize(1000, 800, 0.5, 90)).toEqual({ width: 400, height: 500 });
  });
});

describe("normToPixel — rotation 0", () => {
  it("maps the unit square onto the rendered page box", () => {
    const v = baseView();
    expect(normToPixel({ nx: 0, ny: 0 }, v)).toEqual({ px: 0, py: 0 });
    expect(normToPixel({ nx: 0.5, ny: 0.5 }, v)).toEqual({ px: 500, py: 400 });
    expect(normToPixel({ nx: 1, ny: 1 }, v)).toEqual({ px: 1000, py: 800 });
  });

  it("applies zoom then pan offset", () => {
    const zoomed = normToPixel({ nx: 0.5, ny: 0.5 }, baseView({ zoom: 2 }));
    expect(zoomed).toEqual({ px: 1000, py: 800 });

    const panned = normToPixel({ nx: 0, ny: 0 }, baseView({ offsetX: 50, offsetY: 30 }));
    expect(panned).toEqual({ px: 50, py: 30 });
  });
});

describe("normToPixel — rotation 90 / 180 / 270", () => {
  it("places corners and centre correctly at 90deg", () => {
    const v = baseView({ rotation: 90 }); // rotated box is 800 x 1000
    expect(normToPixel({ nx: 0, ny: 0 }, v)).toEqual({ px: 800, py: 0 });
    expect(normToPixel({ nx: 1, ny: 1 }, v)).toEqual({ px: 0, py: 1000 });
    expect(normToPixel({ nx: 0.5, ny: 0.5 }, v)).toEqual({ px: 400, py: 500 });
  });

  it("places corners and centre correctly at 180deg", () => {
    const v = baseView({ rotation: 180 });
    expect(normToPixel({ nx: 0, ny: 0 }, v)).toEqual({ px: 1000, py: 800 });
    expect(normToPixel({ nx: 1, ny: 1 }, v)).toEqual({ px: 0, py: 0 });
    expect(normToPixel({ nx: 0.5, ny: 0.5 }, v)).toEqual({ px: 500, py: 400 });
  });

  it("places corners and centre correctly at 270deg", () => {
    const v = baseView({ rotation: 270 }); // rotated box is 800 x 1000
    expect(normToPixel({ nx: 0, ny: 0 }, v)).toEqual({ px: 0, py: 1000 });
    expect(normToPixel({ nx: 1, ny: 1 }, v)).toEqual({ px: 800, py: 0 });
    expect(normToPixel({ nx: 0.5, ny: 0.5 }, v)).toEqual({ px: 400, py: 500 });
  });
});

describe("pixelToNorm", () => {
  it("inverts normToPixel and clamps anything off-page into 0..1", () => {
    const v = baseView();
    expect(pixelToNorm({ px: 500, py: 400 }, v)).toEqual({ nx: 0.5, ny: 0.5 });
    // Off the top-left and bottom-right corners -> clamped, never negative or >1.
    expect(pixelToNorm({ px: -100, py: -50 }, v)).toEqual({ nx: 0, ny: 0 });
    expect(pixelToNorm({ px: 5000, py: 5000 }, v)).toEqual({ nx: 1, ny: 1 });
  });

  it("never divides by zero when the page box collapses", () => {
    const r = pixelToNorm({ px: 10, py: 10 }, baseView({ zoom: 0 }));
    expect(Number.isFinite(r.nx)).toBe(true);
    expect(Number.isFinite(r.ny)).toBe(true);
    expect(isNormalised(r)).toBe(true);
  });
});

describe("round-trip: pixelToNorm(normToPixel(p)) === p", () => {
  const points: NormPoint[] = [
    { nx: 0, ny: 0 },
    { nx: 1, ny: 1 },
    { nx: 0.5, ny: 0.5 },
    { nx: 0.13, ny: 0.87 },
    { nx: 0.9, ny: 0.1 },
  ];

  for (const rotation of ROTATIONS) {
    for (const zoom of [0.25, 1, 3.5]) {
      it(`is identity at rotation ${rotation}, zoom ${zoom}`, () => {
        const v = baseView({ rotation, zoom, offsetX: 37, offsetY: -19 });
        for (const p of points) {
          const back = pixelToNorm(normToPixel(p, v), v);
          expect(back.nx).toBeCloseTo(p.nx, 9);
          expect(back.ny).toBeCloseTo(p.ny, 9);
        }
      });
    }
  }
});

describe("fitZoom", () => {
  it("fit-to-width uses the rotated box width", () => {
    expect(fitZoom({ width: 400, height: 400 }, { width: 1000, height: 800 }, 0, "width")).toBeCloseTo(0.4, 9);
    // At 90deg the on-screen width is the page's *height* (800).
    expect(fitZoom({ width: 400, height: 400 }, { width: 1000, height: 800 }, 90, "width")).toBeCloseTo(0.5, 9);
  });

  it("fit-to-page uses the tighter of width / height", () => {
    expect(fitZoom({ width: 400, height: 400 }, { width: 1000, height: 800 }, 0, "page")).toBeCloseTo(0.4, 9);
    expect(fitZoom({ width: 400, height: 400 }, { width: 1000, height: 800 }, 90, "page")).toBeCloseTo(0.4, 9);
  });

  it("returns a positive finite zoom for degenerate inputs", () => {
    expect(fitZoom({ width: 0, height: 0 }, { width: 1000, height: 800 }, 0, "page")).toBeGreaterThan(0);
    expect(Number.isFinite(fitZoom({ width: 400, height: 400 }, { width: 0, height: 0 }, 0, "width"))).toBe(true);
  });
});
