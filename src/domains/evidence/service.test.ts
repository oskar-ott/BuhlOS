import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resizeImageToDataUrl, resizeImageWithMeta } from "./service";

/**
 * Decode + luma coverage for the client resize path.
 *
 * The capture sheet's failure flow already exists end-to-end:
 * `resizeImage*` throws on a createImageBitmap rejection / a missing API, and
 * BOTH consumers (PhilCaptureLauncher tray, CaptureSheet phase) catch it and
 * mark the photo failed. These tests pin that contract — they do NOT
 * re-engineer it — plus the new `resizeImageWithMeta` luma reading that drives
 * the non-blocking low-light hint.
 *
 * Runs in the repo's node test env (no jsdom), so we stub the handful of
 * browser globals the resize touches: `window`, `createImageBitmap`,
 * `OffscreenCanvas`, and `FileReader`.
 */

const g = globalThis as Record<string, unknown>;

/** A flat-fill RGBA buffer of the given size + grey level (0–255). */
function flatFill(width: number, height: number, fill: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill; // R
    data[i + 1] = fill; // G
    data[i + 2] = fill; // B
    data[i + 3] = 255; // A
  }
  return data;
}

/**
 * A mutable fake 2D context. `getImageData` is driven by `ctx.read`, which the
 * test can reassign (e.g. to a custom buffer, or to a thrower) — and because
 * the OffscreenCanvas constructor returns THIS same object, that override
 * survives the resize call.
 */
function makeCtx(fill: number) {
  const ctx = {
    drawImage: vi.fn(),
    // Default reader: a uniform fill at whatever size the resize asks for.
    read: (w: number, h: number) => ({ data: flatFill(w, h, fill) }),
    getImageData(_sx: number, _sy: number, sw: number, sh: number) {
      return ctx.read(sw, sh);
    },
  };
  return ctx;
}

/** Install an OffscreenCanvas backed by a single shared, mutable ctx. */
function installOffscreen(fill: number) {
  const ctx = makeCtx(fill);
  class FakeOffscreenCanvas {
    width: number;
    height: number;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
    }
    getContext() {
      return ctx;
    }
    async convertToBlob() {
      return new Blob(["jpeg-bytes"], { type: "image/jpeg" });
    }
  }
  g.OffscreenCanvas = FakeOffscreenCanvas as unknown;
  return ctx;
}

/** A FileReader stub that resolves readAsDataURL to a fixed jpeg dataURL. */
class FakeFileReader {
  result: string | null = null;
  error: unknown = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL() {
    this.result = "data:image/jpeg;base64,ZmFrZQ==";
    queueMicrotask(() => this.onload?.());
  }
}

beforeEach(() => {
  g.window = {} as unknown;
  g.FileReader = FakeFileReader as unknown;
});

afterEach(() => {
  delete g.window;
  delete g.createImageBitmap;
  delete g.OffscreenCanvas;
  delete g.FileReader;
  vi.restoreAllMocks();
});

describe("resizeImageWithMeta — decode failure path", () => {
  it("(a) propagates a createImageBitmap rejection so callers mark the photo failed", async () => {
    g.createImageBitmap = vi.fn(async () => {
      throw new Error("The source image could not be decoded.");
    });
    installOffscreen(128);

    await expect(resizeImageWithMeta(new Blob(["x"]))).rejects.toThrow(
      /could not be decoded/i,
    );
    // The string-returning wrapper surfaces the SAME rejection (one code path).
    await expect(resizeImageToDataUrl(new Blob(["x"]))).rejects.toThrow(
      /could not be decoded/i,
    );
  });

  it("(b) throws the existing honest error when createImageBitmap is missing", async () => {
    delete g.createImageBitmap;
    installOffscreen(128);

    await expect(resizeImageWithMeta(new Blob(["x"]))).rejects.toThrow(
      /createImageBitmap not available/i,
    );
    await expect(resizeImageToDataUrl(new Blob(["x"]))).rejects.toThrow(
      /createImageBitmap not available/i,
    );
  });

  it("throws browser-only when window is undefined", async () => {
    delete g.window;
    await expect(resizeImageWithMeta(new Blob(["x"]))).rejects.toThrow(/browser-only/i);
  });
});

describe("resizeImageWithMeta — luma reading (c)", () => {
  it("returns a dataUrl plus a high avgLuma for a bright frame", async () => {
    g.createImageBitmap = vi.fn(async () => ({ width: 100, height: 100 }));
    installOffscreen(255);

    const res = await resizeImageWithMeta(new Blob(["x"]));
    expect(res.dataUrl).toMatch(/^data:image\/jpeg/);
    expect(res.avgLuma).not.toBeNull();
    expect(res.avgLuma!).toBeGreaterThan(200);
  });

  it("returns a low avgLuma for a dark frame", async () => {
    g.createImageBitmap = vi.fn(async () => ({ width: 100, height: 100 }));
    installOffscreen(8);

    const res = await resizeImageWithMeta(new Blob(["x"]));
    expect(res.avgLuma).not.toBeNull();
    expect(res.avgLuma!).toBeLessThan(20);
  });

  it("measures Rec.601 luma (green weighted over red/blue), not a flat mean", async () => {
    g.createImageBitmap = vi.fn(async () => ({ width: 2, height: 1 }));
    // Pure-green pixels: Rec.601 luma = 0.587 * 255 ≈ 149.7, a flat mean of
    // R/G/B would be 85. Assert the weighted value, proving the coefficients.
    const ctx = installOffscreen(0);
    const data = new Uint8ClampedArray(2 * 1 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 0;
      data[i + 1] = 255; // green
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
    ctx.read = () => ({ data });

    const res = await resizeImageWithMeta(new Blob(["x"]));
    expect(res.avgLuma!).toBeGreaterThan(145);
    expect(res.avgLuma!).toBeLessThan(155);
  });

  it("reports avgLuma null (never 'dark') when getImageData throws (tainted canvas)", async () => {
    g.createImageBitmap = vi.fn(async () => ({ width: 50, height: 50 }));
    const ctx = installOffscreen(128);
    ctx.read = () => {
      throw new Error("SecurityError: tainted canvas");
    };

    const res = await resizeImageWithMeta(new Blob(["x"]));
    // Still produces a usable dataUrl — the resize is unaffected.
    expect(res.dataUrl).toMatch(/^data:image\/jpeg/);
    expect(res.avgLuma).toBeNull();
  });

  it("the string wrapper returns just the dataUrl (signature intact)", async () => {
    g.createImageBitmap = vi.fn(async () => ({ width: 20, height: 20 }));
    installOffscreen(128);

    const out = await resizeImageToDataUrl(new Blob(["x"]), 1920, 0.7);
    expect(typeof out).toBe("string");
    expect(out).toMatch(/^data:image\/jpeg/);
  });
});
