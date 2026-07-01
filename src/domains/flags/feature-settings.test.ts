import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #760 PR2 — per-feature config knobs against the REAL module (require-cache
 * blob injection). Pins: default-until-overridden, re-validation on read
 * (out-of-range / wrong-type → default, dark-safe), unknown-key throw, and the
 * strict write-time validation used by api/owner-settings.js.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const settingsPath = requireFromHere.resolve("../../../api/_lib/feature-settings.js");

type Value = number | string | boolean;
type SettingsModule = {
  getSetting: (f: string, k: string) => Promise<Value>;
  getSettings: (f: string) => Promise<Record<string, Value>>;
  validateWrite: (f: string, k: string, v: unknown) => { ok: boolean; value?: Value; error?: string };
  listSettings: () => Array<{ featureKey: string; key: string; default: Value }>;
};

let blob: Map<string, unknown>;
let settings: SettingsModule;

const FK = "safety_docs";
const K = "maxUploadMb"; // number, default 25, range 1–100

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
});

describe("resolver (default until overridden, dark-safe)", () => {
  it("returns the registry default when nothing is stored", async () => {
    expect(await settings.getSetting(FK, K)).toBe(25);
  });

  it("returns a valid stored override", async () => {
    blob.set("feature-settings.json", { settings: { [FK]: { [K]: 50 } } });
    expect(await settings.getSetting(FK, K)).toBe(50);
  });

  it("falls back to default on an out-of-range or wrong-type stored value", async () => {
    blob.set("feature-settings.json", { settings: { [FK]: { [K]: 9999 } } }); // > max 100
    expect(await settings.getSetting(FK, K)).toBe(25);
    blob.set("feature-settings.json", { settings: { [FK]: { [K]: "lots" } } });
    expect(await settings.getSetting(FK, K)).toBe(25);
  });

  it("falls back to default when the blob is unavailable", async () => {
    const mod = requireFromHere.cache[blobPath]!.exports as { readBlob: ReturnType<typeof vi.fn> };
    mod.readBlob.mockImplementationOnce(async () => {
      throw new Error("blob down");
    });
    expect(await settings.getSetting(FK, K)).toBe(25);
  });

  it("throws on an unknown feature or key", async () => {
    await expect(settings.getSetting("nope", K)).rejects.toThrow(/unknown feature setting/);
    await expect(settings.getSetting(FK, "nope")).rejects.toThrow(/unknown feature setting/);
  });

  it("getSettings resolves the whole feature group in one read", async () => {
    blob.set("feature-settings.json", { settings: { minutes_register: { bodyMaxChars: 12345 } } });
    expect(await settings.getSettings("minutes_register")).toEqual({ bodyMaxChars: 12345 });
  });

  it("every registry default is itself a valid value (resolves to the default)", async () => {
    for (const s of settings.listSettings()) {
      expect(await settings.getSetting(s.featureKey, s.key)).toBe(s.default);
    }
  });
});

describe("validateWrite (strict, operator-facing)", () => {
  it("accepts an in-range value", () => {
    expect(settings.validateWrite(FK, K, 40)).toEqual({ ok: true, value: 40 });
  });

  it("rejects out-of-range / wrong-type with a message", () => {
    const lo = settings.validateWrite(FK, K, 0);
    const hi = settings.validateWrite(FK, K, 999);
    const str = settings.validateWrite(FK, K, "x");
    expect(lo.ok).toBe(false);
    expect(hi.ok).toBe(false);
    expect(str.ok).toBe(false);
    expect(hi.error).toMatch(/between 1 and 100/);
  });

  it("throws on an unknown setting (caller maps to 404)", () => {
    expect(() => settings.validateWrite("nope", K, 1)).toThrow(/unknown feature setting/);
  });
});
