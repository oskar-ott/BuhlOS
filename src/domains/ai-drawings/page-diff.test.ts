import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * #203 — the revision-diff engine against REAL synthetic PNGs (pngjs both
 * generates the fixtures and decodes inside the engine — no mocks):
 *   * unchanged drawings → clean pass, no regions
 *   * an added element → a region that actually covers it
 *   * a few px of render drift → alignment absorbs it (no false regions)
 *   * a change only in the title-block region → masked out
 *   * unrelated images → refuses honestly ("could not compare")
 *   * different aspect ratios → refuses honestly
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CJS PNG codec, used structurally
const { PNG } = requireFromHere("pngjs") as any;
const pageDiff = requireFromHere("../../../api/_lib/page-diff.js") as {
  ALGO_VERSION: string;
  diffPages: (head: Buffer, base: Buffer) => {
    ok: boolean;
    reason?: string;
    identical?: boolean;
    alignment?: { dx: number; dy: number; quality: number };
    regions?: Array<{ bbox: { x: number; y: number; w: number; h: number }; areaCells: number }>;
  };
};

type SetPx = (x: number, y: number, v: number) => void;

const W = 800;
const H = 600;

function makePng(w: number, h: number, draw?: (set: SetPx) => void): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i += 1) {
    png.data[i * 4] = 255;
    png.data[i * 4 + 1] = 255;
    png.data[i * 4 + 2] = 255;
    png.data[i * 4 + 3] = 255;
  }
  const set: SetPx = (x, y, v) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    png.data[i] = v;
    png.data[i + 1] = v;
    png.data[i + 2] = v;
  };
  draw?.(set);
  return PNG.sync.write(png);
}

function rect(set: SetPx, x0: number, y0: number, x1: number, y1: number, v = 0) {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) set(x, y, v);
  }
}

// A plausible "sheet": border + a few wall lines.
function baseDrawing(set: SetPx, shiftX = 0) {
  rect(set, 50 + shiftX, 50, 750 + shiftX, 54);
  rect(set, 50 + shiftX, 546, 750 + shiftX, 550);
  rect(set, 50 + shiftX, 50, 54 + shiftX, 550);
  rect(set, 746 + shiftX, 50, 750 + shiftX, 550);
  rect(set, 100 + shiftX, 150, 400 + shiftX, 154);
  rect(set, 100 + shiftX, 250, 500 + shiftX, 254);
  rect(set, 300 + shiftX, 350, 304 + shiftX, 500);
}

describe("page-diff engine (#203)", () => {
  it("unchanged drawings compare clean — high alignment quality, zero regions", () => {
    const a = makePng(W, H, (s) => baseDrawing(s));
    const b = makePng(W, H, (s) => baseDrawing(s));
    const out = pageDiff.diffPages(a, b);
    expect(out.ok).toBe(true);
    expect(out.alignment!.quality).toBeGreaterThan(0.9);
    expect(out.regions).toHaveLength(0);
  });

  it("an added element yields a region that covers it", () => {
    const base = makePng(W, H, (s) => baseDrawing(s));
    const head = makePng(W, H, (s) => {
      baseDrawing(s);
      rect(s, 200, 350, 300, 430); // the new element on the newer revision
    });
    const out = pageDiff.diffPages(head, base);
    expect(out.ok).toBe(true);
    expect(out.regions!.length).toBeGreaterThanOrEqual(1);
    const r = out.regions![0]!.bbox; // largest first
    // the region must contain the element's centre (250, 390 → 0.3125, 0.65)
    expect(r.x).toBeLessThanOrEqual(0.3125);
    expect(r.x + r.w).toBeGreaterThanOrEqual(0.3125);
    expect(r.y).toBeLessThanOrEqual(0.65);
    expect(r.y + r.h).toBeGreaterThanOrEqual(0.65);
  });

  it("a few pixels of render drift is absorbed by alignment — no false regions", () => {
    const base = makePng(W, H, (s) => baseDrawing(s, 0));
    const head = makePng(W, H, (s) => baseDrawing(s, 6));
    const out = pageDiff.diffPages(head, base);
    expect(out.ok).toBe(true);
    expect(Math.abs(out.alignment!.dx)).toBe(6);
    expect(out.regions).toHaveLength(0);
  });

  it("a change only inside the title-block mask is ignored (revision tables always change)", () => {
    const base = makePng(W, H, (s) => baseDrawing(s));
    const head = makePng(W, H, (s) => {
      baseDrawing(s);
      // mask is {x:0.6,y:0.7,w:0.4,h:0.3} → pixels x≥480, y≥420
      rect(s, 560, 480, 700, 560);
    });
    const out = pageDiff.diffPages(head, base);
    expect(out.ok).toBe(true);
    expect(out.regions).toHaveLength(0);
  });

  it("unrelated images refuse honestly instead of emitting a junk diff", () => {
    const base = makePng(W, H, (s) => baseDrawing(s));
    // deterministic pseudo-noise (xorshift) — a wholly different image
    let seed = 0x2545f491;
    const head = makePng(W, H, (s) => {
      for (let y = 0; y < H; y += 2) {
        for (let x = 0; x < W; x += 2) {
          seed ^= seed << 13;
          seed ^= seed >>> 17;
          seed ^= seed << 5;
          if ((seed & 3) === 0) rect(s, x, y, x + 2, y + 2);
        }
      }
    });
    const out = pageDiff.diffPages(head, base);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/could not compare/);
  });

  it("different aspect ratios refuse honestly (not the same sheet)", () => {
    const a = makePng(800, 600, (s) => baseDrawing(s));
    const b = makePng(800, 500, (s) => baseDrawing(s));
    const out = pageDiff.diffPages(a, b);
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/aspect/);
  });

  it("garbage buffers refuse honestly", () => {
    const out = pageDiff.diffPages(Buffer.from("not a png"), Buffer.from("also not"));
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/decode/);
  });
});
