import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #760 PR2 — per-feature config knobs against the REAL module (require-cache
 * blob injection). Pins: default-until-overridden, re-validation on read
 * (out-of-range / wrong-type → default, dark-safe), unknown-key throw, and the
 * strict write-time validation used by api/owner-settings.js.
 *
 * The live registry is EMPTY (the job-page rebuild deleted itp_simple's
 * knobs, the last registered feature), so these tests register a FIXTURE
 * feature group via the exported SETTINGS_REGISTRY to exercise the seam.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const settingsPath = requireFromHere.resolve("../../../api/_lib/feature-settings.js");

type Value = number | string | boolean;
type SettingsModule = {
  SETTINGS_REGISTRY: Record<string, Record<string, unknown>>;
  getSetting: (f: string, k: string) => Promise<Value>;
  getSettings: (f: string) => Promise<Record<string, Value>>;
  validateWrite: (f: string, k: string, v: unknown) => { ok: boolean; value?: Value; error?: string };
  listSettings: () => Array<{ featureKey: string; key: string; default: Value }>;
};

let blob: Map<string, unknown>;
let settings: SettingsModule;

const FK = "test_feature"; // fixture group registered in beforeEach
const K = "maxUploadMb"; // number, default 8, range 1–25

beforeEach(() => {
  blob = new Map<string, unknown>();
  delete requireFromHere.cache[settingsPath];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? JSON.parse(JSON.stringify(blob.get(key))) : fallback,
      ),
      writeBlob: vi.fn(),
      deleteBlob: vi.fn(),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  settings = requireFromHere(settingsPath);
  // Register the fixture group (the live registry is empty — see header).
  settings.SETTINGS_REGISTRY[FK] = {
    maxUploadMb: {
      type: "number", label: "Max photo size (MB)", description: "fixture",
      default: 8, min: 1, max: 25, step: 1, unit: "MB",
    },
    maxPdfPhotos: {
      type: "number", label: "Max photos per PDF", description: "fixture",
      default: 120, min: 10, max: 400, step: 10, unit: "photos",
    },
  };
});

describe("resolver (default until overridden, dark-safe)", () => {
  it("returns the registry default when nothing is stored", async () => {
    expect(await settings.getSetting(FK, K)).toBe(8);
  });

  it("returns a valid stored override", async () => {
    blob.set("feature-settings.json", { settings: { [FK]: { [K]: 20 } } });
    expect(await settings.getSetting(FK, K)).toBe(20);
  });

  it("falls back to default on an out-of-range or wrong-type stored value", async () => {
    blob.set("feature-settings.json", { settings: { [FK]: { [K]: 9999 } } }); // > max 100
    expect(await settings.getSetting(FK, K)).toBe(8);
    blob.set("feature-settings.json", { settings: { [FK]: { [K]: "lots" } } });
    expect(await settings.getSetting(FK, K)).toBe(8);
  });

  it("falls back to default when the blob is unavailable", async () => {
    const mod = requireFromHere.cache[blobPath]!.exports as { readBlob: ReturnType<typeof vi.fn> };
    mod.readBlob.mockImplementationOnce(async () => {
      throw new Error("blob down");
    });
    expect(await settings.getSetting(FK, K)).toBe(8);
  });

  it("throws on an unknown feature or key", async () => {
    await expect(settings.getSetting("nope", K)).rejects.toThrow(/unknown feature setting/);
    await expect(settings.getSetting(FK, "nope")).rejects.toThrow(/unknown feature setting/);
  });

  it("getSettings resolves the whole feature group in one read", async () => {
    blob.set("feature-settings.json", { settings: { [FK]: { maxPdfPhotos: 200 } } });
    expect(await settings.getSettings(FK)).toEqual({ maxUploadMb: 8, maxPdfPhotos: 200 });
  });

  it("every registry default is itself a valid value (resolves to the default)", async () => {
    for (const s of settings.listSettings()) {
      expect(await settings.getSetting(s.featureKey, s.key)).toBe(s.default);
    }
  });
});

describe("validateWrite (strict, operator-facing)", () => {
  it("accepts an in-range value", () => {
    expect(settings.validateWrite(FK, K, 20)).toEqual({ ok: true, value: 20 });
  });

  it("rejects out-of-range / wrong-type with a message", () => {
    const lo = settings.validateWrite(FK, K, 0);
    const hi = settings.validateWrite(FK, K, 999);
    const str = settings.validateWrite(FK, K, "x");
    expect(lo.ok).toBe(false);
    expect(hi.ok).toBe(false);
    expect(str.ok).toBe(false);
    expect(hi.error).toMatch(/between 1 and 25/);
  });

  it("throws on an unknown setting (caller maps to 404)", () => {
    expect(() => settings.validateWrite("nope", K, 1)).toThrow(/unknown feature setting/);
  });
});
