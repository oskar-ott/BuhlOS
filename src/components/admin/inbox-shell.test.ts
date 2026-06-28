import { describe, expect, it } from "vitest";
import {
  INBOX_STAT_DASH,
  inboxFilterCountLabel,
  inboxStatToneClass,
  isMutedStatValue,
  type InboxStatTone,
} from "./inbox-shell";

/**
 * Pure unit tests for the shared inbox-shell shaping helpers (brief §6). These
 * pin the HONESTY rule (the project's #1 law): a missing or zero signal must
 * read calm/muted — never light up an unearned warning/danger colour, never
 * fabricate a 0 — and the colour palette must match the registers it replaces.
 */

describe("isMutedStatValue", () => {
  it("treats a real numeric zero as muted (calm empty queue)", () => {
    expect(isMutedStatValue(0)).toBe(true);
  });

  it("treats any positive count as not muted (it carries its tone)", () => {
    expect(isMutedStatValue(1)).toBe(false);
    expect(isMutedStatValue(42)).toBe(false);
  });

  it("treats the dash placeholder and blank/zero strings as muted", () => {
    expect(isMutedStatValue(INBOX_STAT_DASH)).toBe(true);
    expect(isMutedStatValue("—")).toBe(true);
    expect(isMutedStatValue("")).toBe(true);
    expect(isMutedStatValue("   ")).toBe(true);
    expect(isMutedStatValue("0")).toBe(true);
  });

  it("treats a formatted currency / non-zero string as not muted", () => {
    expect(isMutedStatValue("$42.50")).toBe(false);
    expect(isMutedStatValue("3")).toBe(false);
  });
});

describe("inboxStatToneClass", () => {
  const TONES: InboxStatTone[] = ["neutral", "warning", "danger", "success", "info"];

  it("collapses every tone to muted when the value carries no signal", () => {
    for (const tone of TONES) {
      expect(inboxStatToneClass(tone, true)).toBe("text-text-muted");
    }
  });

  it("maps each tone to its register palette class when not muted", () => {
    expect(inboxStatToneClass("danger", false)).toBe("text-rose-700");
    expect(inboxStatToneClass("warning", false)).toBe("text-amber-700");
    expect(inboxStatToneClass("success", false)).toBe("text-emerald-700");
    expect(inboxStatToneClass("info", false)).toBe("text-sky-700");
    expect(inboxStatToneClass("neutral", false)).toBe("text-text");
  });
});

describe("inboxFilterCountLabel", () => {
  it("formats the visible-of-total count", () => {
    expect(inboxFilterCountLabel(3, 12)).toBe("3 of 12");
    expect(inboxFilterCountLabel(0, 0)).toBe("0 of 0");
  });
});
