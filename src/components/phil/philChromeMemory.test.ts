import { beforeEach, describe, expect, it } from "vitest";
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
 * `false`, always overwrite.
 */
describe("philChromeMemory", () => {
  beforeEach(() => {
    resetPhilChromeMemoryForTests();
  });

  it("starts at the safe defaults (today's chrome)", () => {
    expect(readPhilChromeMemory()).toEqual({
      sharpened: false,
      rfiRegister: false,
      jobRooms: false,
      accountInitials: null,
    });
  });

  it("merges only the keys present in the patch", () => {
    rememberPhilChrome({ sharpened: true });
    expect(readPhilChromeMemory()).toEqual({
      sharpened: true,
      rfiRegister: false,
      jobRooms: false,
      accountInitials: null,
    });
    rememberPhilChrome({ jobRooms: true, accountInitials: "SP" });
    expect(readPhilChromeMemory()).toEqual({
      sharpened: true,
      rfiRegister: false,
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
      sharpened: false,
      rfiRegister: false,
      jobRooms: false,
      accountInitials: null,
    });
  });
});
