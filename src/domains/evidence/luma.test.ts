import { describe, expect, it } from "vitest";
import { LOW_LIGHT_LUMA_THRESHOLD, isLowLight } from "./luma";

/**
 * Low-light cutoff is a unit-tested constant, never a magic number. These tests
 * pin the boundary behaviour so a future tweak to the threshold is a deliberate,
 * reviewed change — and so the non-blocking hint only ever fires on genuinely
 * dark readings, not on guesses or usable frames.
 */
describe("isLowLight", () => {
  it("flags a clearly dark reading", () => {
    expect(isLowLight(5)).toBe(true);
    expect(isLowLight(0)).toBe(true);
    expect(isLowLight(LOW_LIGHT_LUMA_THRESHOLD - 1)).toBe(true);
  });

  it("does NOT flag a normally-exposed reading", () => {
    expect(isLowLight(128)).toBe(false);
    expect(isLowLight(255)).toBe(false);
    expect(isLowLight(LOW_LIGHT_LUMA_THRESHOLD + 1)).toBe(false);
  });

  it("treats exactly-at-threshold as fine (strictly below fires)", () => {
    expect(isLowLight(LOW_LIGHT_LUMA_THRESHOLD)).toBe(false);
  });

  it("never guesses: null / undefined / NaN / Infinity are not low light", () => {
    expect(isLowLight(null)).toBe(false);
    expect(isLowLight(undefined)).toBe(false);
    expect(isLowLight(NaN)).toBe(false);
    expect(isLowLight(Infinity)).toBe(false);
    expect(isLowLight(-Infinity)).toBe(false);
  });

  it("keeps the threshold inside the valid 0–255 luma range", () => {
    expect(LOW_LIGHT_LUMA_THRESHOLD).toBeGreaterThan(0);
    expect(LOW_LIGHT_LUMA_THRESHOLD).toBeLessThan(255);
  });
});
