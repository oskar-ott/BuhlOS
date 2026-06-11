import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #155 — the flag system against the REAL module (require-cache blob
 * injection, real auth tier helpers). Pins the resolution order
 * (env > blob override > default), dark-by-default, unknown-key throw,
 * admin-tier targeting and the expiry guard's source of truth.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const flagsPath = requireFromHere.resolve("../../../api/_lib/feature-flags.js");

type FlagsModule = {
  isFlagOn: (key: string) => Promise<boolean>;
  isFlagEnabled: (key: string, viewer?: { role?: string | null } | null) => Promise<boolean>;
  flagsForViewer: (viewer?: { role?: string | null } | null) => Promise<Record<string, boolean>>;
  expiredFlags: (now?: Date) => Array<{ key: string; expires: string }>;
  REGISTRY: Record<string, { default: boolean; target: string; expires: string }>;
};

let blob: Map<string, unknown>;
let flags: FlagsModule;

const KEY = "supabase_dual_write"; // global-target registry entry
const ADMIN_KEY = "admin_flags_readout"; // admin-tier-target registry entry

beforeEach(() => {
  delete process.env.FLAG_SUPABASE_DUAL_WRITE;
  delete process.env.FLAG_ADMIN_FLAGS_READOUT;
  blob = new Map<string, unknown>();
  delete requireFromHere.cache[flagsPath];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? JSON.parse(JSON.stringify(blob.get(key))) : fallback
      ),
      writeBlob: vi.fn(),
      deleteBlob: vi.fn(),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  flags = requireFromHere(flagsPath);
});

afterEach(() => {
  delete process.env.FLAG_SUPABASE_DUAL_WRITE;
  delete process.env.FLAG_ADMIN_FLAGS_READOUT;
});

describe("resolution order (env > blob override > default)", () => {
  it("is dark by default — every registry entry defaults off", async () => {
    for (const [key, def] of Object.entries(flags.REGISTRY)) {
      expect(def.default).toBe(false);
      expect(await flags.isFlagOn(key)).toBe(false);
    }
  });

  it("the blob override turns a flag on at runtime", async () => {
    blob.set("flags.json", { flags: { [KEY]: true } });
    expect(await flags.isFlagOn(KEY)).toBe(true);
  });

  it("an env var beats the blob override in BOTH directions", async () => {
    blob.set("flags.json", { flags: { [KEY]: true } });
    process.env.FLAG_SUPABASE_DUAL_WRITE = "0";
    expect(await flags.isFlagOn(KEY)).toBe(false);
    blob.set("flags.json", { flags: { [KEY]: false } });
    process.env.FLAG_SUPABASE_DUAL_WRITE = "1";
    expect(await flags.isFlagOn(KEY)).toBe(true);
  });

  it("an unparseable env value falls through instead of guessing", async () => {
    process.env.FLAG_SUPABASE_DUAL_WRITE = "banana";
    blob.set("flags.json", { flags: { [KEY]: true } });
    expect(await flags.isFlagOn(KEY)).toBe(true);
  });

  it("a broken flags blob behaves as no-override (dark)", async () => {
    const mod = requireFromHere.cache[blobPath]!.exports as { readBlob: ReturnType<typeof vi.fn> };
    mod.readBlob.mockImplementationOnce(async () => {
      throw new Error("blob down");
    });
    expect(await flags.isFlagOn(KEY)).toBe(false);
  });

  it("unknown flag names THROW — a typo never silently resolves false", async () => {
    await expect(flags.isFlagOn("not_a_flag")).rejects.toThrow(/unknown feature flag/);
  });
});

describe("role-tier targeting", () => {
  it("an admin-tier flag is on for the whole admin tier, never the field or anonymous", async () => {
    process.env.FLAG_ADMIN_FLAGS_READOUT = "1";
    expect(await flags.isFlagEnabled(ADMIN_KEY, { role: "admin" })).toBe(true);
    expect(await flags.isFlagEnabled(ADMIN_KEY, { role: "boss" })).toBe(true); // tier, not literal
    expect(await flags.isFlagEnabled(ADMIN_KEY, { role: "office" })).toBe(true);
    expect(await flags.isFlagEnabled(ADMIN_KEY, { role: "electrician" })).toBe(false);
    expect(await flags.isFlagEnabled(ADMIN_KEY, { role: "leadingHand" })).toBe(false);
    expect(await flags.isFlagEnabled(ADMIN_KEY, null)).toBe(false);
  });

  it("targeting never turns an OFF flag on", async () => {
    expect(await flags.isFlagEnabled(ADMIN_KEY, { role: "admin" })).toBe(false);
  });

  it("a global flag ignores the viewer once enabled", async () => {
    process.env.FLAG_SUPABASE_DUAL_WRITE = "1";
    expect(await flags.isFlagEnabled(KEY, { role: "electrician" })).toBe(true);
    expect(await flags.isFlagEnabled(KEY, null)).toBe(true);
  });

  it("flagsForViewer returns the viewer-scoped projection only", async () => {
    process.env.FLAG_ADMIN_FLAGS_READOUT = "1";
    const field = await flags.flagsForViewer({ role: "electrician" });
    expect(field[ADMIN_KEY]).toBe(false);
    const boss = await flags.flagsForViewer({ role: "boss" });
    expect(boss[ADMIN_KEY]).toBe(true);
  });
});

describe("expiry (flags are temporary)", () => {
  it("reports flags past their declared expiry and none before it", () => {
    expect(flags.expiredFlags(new Date("2026-06-12T00:00:00Z"))).toEqual([]);
    const expired = flags.expiredFlags(new Date("2027-01-01T00:00:00Z"));
    expect(expired.map((f) => f.key)).toContain(KEY);
  });
});
