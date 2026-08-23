import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readPhilChromeMemory,
  rememberPhilChrome,
  resetPhilChromeMemoryForTests,
} from "./philChromeMemory";

/**
 * The chrome-memory singleton behind the loading-skeleton chrome fallback:
 * flag-less renders (loading.tsx) consult it post-mount, explicit props
 * refresh it. These tests pin its merge semantics — in particular that an
 * `undefined` key is a NO-OP (the "not resolved here" signal must never
 * erase a remembered value) while explicit values, including `null` and
 * `false`, always overwrite — and the chrome-hint cookie SYNC that rides
 * every confirming write (the cold-start half of the fallback,
 * src/domains/phil/chrome-hint.ts).
 */
describe("philChromeMemory", () => {
  beforeEach(() => {
    resetPhilChromeMemoryForTests();
  });

  it("starts with nothing confirmed (null = no server-resolved value yet)", () => {
    expect(readPhilChromeMemory()).toEqual({
      sharpened: null,
      rfiRegister: null,
      jobRooms: null,
      accountInitials: null,
    });
  });

  it("merges only the keys present in the patch", () => {
    rememberPhilChrome({ sharpened: true });
    expect(readPhilChromeMemory()).toEqual({
      sharpened: true,
      rfiRegister: null,
      jobRooms: null,
      accountInitials: null,
    });
    rememberPhilChrome({ jobRooms: true, accountInitials: "SP" });
    expect(readPhilChromeMemory()).toEqual({
      sharpened: true,
      rfiRegister: null,
      jobRooms: true,
      accountInitials: "SP",
    });
  });

  it("treats undefined values as no-ops — never erases a remembered value", () => {
    rememberPhilChrome({
      sharpened: true,
      rfiRegister: true,
      jobRooms: true,
      accountInitials: "SP",
    });
    rememberPhilChrome({
      sharpened: undefined,
      rfiRegister: undefined,
      jobRooms: undefined,
      accountInitials: undefined,
    });
    expect(readPhilChromeMemory()).toEqual({
      sharpened: true,
      rfiRegister: true,
      jobRooms: true,
      accountInitials: "SP",
    });
  });

  it("explicit false / null DO overwrite (flag-off pages write false)", () => {
    rememberPhilChrome({
      sharpened: true,
      rfiRegister: true,
      jobRooms: true,
      accountInitials: "SP",
    });
    rememberPhilChrome({
      sharpened: false,
      rfiRegister: false,
      jobRooms: false,
      accountInitials: null,
    });
    expect(readPhilChromeMemory()).toEqual({
      sharpened: false,
      rfiRegister: false,
      jobRooms: false,
      accountInitials: null,
    });
  });

  it("resetPhilChromeMemoryForTests restores the defaults", () => {
    rememberPhilChrome({ sharpened: true, accountInitials: "SP" });
    resetPhilChromeMemoryForTests();
    expect(readPhilChromeMemory()).toEqual({
      sharpened: null,
      rfiRegister: null,
      jobRooms: null,
      accountInitials: null,
    });
  });
});

/**
 * Cookie sync (chrome-hint.ts). Vitest runs in the node environment — no DOM —
 * which is itself the first assertion: with `document` undefined every
 * remember above completed without touching a cookie. Here we install a
 * minimal recording `document` stub to pin the write rules:
 *   * nothing confirmed → never write (flag-less pages leave the hint alone);
 *   * sharpened confirmed on → set `s1.r{0|1}`, once (no churn when in sync);
 *   * unconfirmed jobRooms inherits the existing cookie's bit;
 *   * sharpened confirmed off → expire ONLY an existing cookie (a flag-off
 *     viewer with no cookie sees zero writes, byte-identical behaviour).
 */
describe("philChromeMemory — chrome-hint cookie sync", () => {
  let writes: string[];

  beforeEach(() => {
    resetPhilChromeMemoryForTests();
    writes = [];
    let jar = "";
    (globalThis as { document?: unknown }).document = {
      get cookie() {
        return jar;
      },
      set cookie(v: string) {
        writes.push(v);
        // Enough cookie semantics for the sync's read-back: max-age=0 clears
        // the jar, a set stores the name=value pair alone.
        jar = /max-age=0/.test(v) ? "" : (v.split(";")[0] ?? "");
      },
    };
  });

  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
    resetPhilChromeMemoryForTests();
  });

  it("writes nothing while no flag has been server-confirmed", () => {
    rememberPhilChrome({ accountInitials: "SP" });
    rememberPhilChrome({});
    expect(writes).toEqual([]);
  });

  it("sets the baseline on confirm, and skips the write when already in sync", () => {
    rememberPhilChrome({ sharpened: true, jobRooms: false });
    expect(writes).toEqual([
      "phil_chrome=s1.r0; path=/; max-age=15552000; samesite=lax",
    ]);
    rememberPhilChrome({ sharpened: true, jobRooms: false });
    expect(writes).toHaveLength(1);
    rememberPhilChrome({ jobRooms: true });
    expect(writes[1]).toContain("phil_chrome=s1.r1;");
  });

  it("an unconfirmed jobRooms inherits the existing cookie's bit — no downgrade", () => {
    (globalThis as { document: { cookie: string } }).document.cookie =
      "phil_chrome=s1.r1; path=/; max-age=15552000; samesite=lax";
    writes = [];
    rememberPhilChrome({ sharpened: true });
    // In sync (s1.r1 preserved) → no write at all.
    expect(writes).toEqual([]);
  });

  it("sharpened confirmed OFF expires an existing cookie…", () => {
    rememberPhilChrome({ sharpened: true });
    rememberPhilChrome({ sharpened: false });
    expect(writes[1]).toBe("phil_chrome=; path=/; max-age=0; samesite=lax");
  });

  it("…but a flag-off viewer with no cookie sees zero writes", () => {
    rememberPhilChrome({ sharpened: false, jobRooms: false });
    expect(writes).toEqual([]);
  });
});
