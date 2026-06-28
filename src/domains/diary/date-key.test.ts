import { describe, expect, it } from "vitest";
import {
  inDateRange,
  isDateKey,
  isFutureDate,
  sydneyDateKey,
  sydneyToday,
} from "./date-key";

/**
 * Sydney-day boundary tests for the diary date-key (#210). The key rule: a late
 * Sydney-evening save must land on the LOCAL date, not the UTC date — mirroring
 * site-visits.js sydneyToday so the diary and the attendance lookup it snapshots
 * agree on what "today" is.
 */

describe("sydneyDateKey", () => {
  it("returns YYYY-MM-DD shape", () => {
    expect(sydneyDateKey(new Date("2026-06-15T03:00:00Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("maps a 9pm-Sydney winter instant to the SAME local day (UTC+10)", () => {
    // 2026-06-15 21:00 Sydney (AEST, UTC+10) = 2026-06-15 11:00 UTC — same day.
    expect(sydneyDateKey(new Date("2026-06-15T11:00:00Z"))).toBe("2026-06-15");
  });

  it("rolls a late-Sydney-evening instant onto the right local date, not UTC", () => {
    // 2026-06-15 23:30 Sydney (AEST, UTC+10) = 2026-06-15 13:30 UTC.
    // Naively using the UTC date is still the 15th here, but the early-morning
    // case below is the one that diverges — assert both to lock the boundary.
    expect(sydneyDateKey(new Date("2026-06-15T13:30:00Z"))).toBe("2026-06-15");
  });

  it("maps an early-morning UTC instant to the Sydney NEXT day", () => {
    // 2026-06-15 23:00 UTC = 2026-06-16 09:00 Sydney → the 16th locally.
    expect(sydneyDateKey(new Date("2026-06-15T23:00:00Z"))).toBe("2026-06-16");
  });

  it("handles AEDT (UTC+11) summer offset", () => {
    // 2026-01-15 14:00 UTC = 2026-01-16 01:00 Sydney (daylight saving) → the 16th.
    expect(sydneyDateKey(new Date("2026-01-15T14:00:00Z"))).toBe("2026-01-16");
  });
});

describe("isDateKey", () => {
  it("accepts a well-formed key and rejects others", () => {
    expect(isDateKey("2026-06-15")).toBe(true);
    expect(isDateKey("2026-6-15")).toBe(false);
    expect(isDateKey("2026-06-15T00:00:00Z")).toBe(false);
    expect(isDateKey("")).toBe(false);
    expect(isDateKey(null)).toBe(false);
    expect(isDateKey(20260615)).toBe(false);
  });
});

describe("isFutureDate", () => {
  const now = new Date("2026-06-15T11:00:00Z"); // 2026-06-15 Sydney

  it("flags tomorrow as future", () => {
    expect(isFutureDate("2026-06-16", now)).toBe(true);
  });

  it("allows today and back-dating", () => {
    expect(isFutureDate(sydneyToday(now), now)).toBe(false);
    expect(isFutureDate("2026-06-15", now)).toBe(false);
    expect(isFutureDate("2026-06-14", now)).toBe(false);
    expect(isFutureDate("2026-01-01", now)).toBe(false);
  });
});

describe("inDateRange", () => {
  it("is inclusive on both bounds", () => {
    expect(inDateRange("2026-06-15", "2026-06-15", "2026-06-15")).toBe(true);
    expect(inDateRange("2026-06-15", "2026-06-10", "2026-06-20")).toBe(true);
    expect(inDateRange("2026-06-09", "2026-06-10", "2026-06-20")).toBe(false);
    expect(inDateRange("2026-06-21", "2026-06-10", "2026-06-20")).toBe(false);
  });

  it("treats missing bounds as unbounded", () => {
    expect(inDateRange("2026-06-15")).toBe(true);
    expect(inDateRange("2026-06-15", "2026-06-10")).toBe(true);
    expect(inDateRange("2026-06-05", "2026-06-10")).toBe(false);
    expect(inDateRange("2026-06-15", null, "2026-06-20")).toBe(true);
    expect(inDateRange("2026-06-25", null, "2026-06-20")).toBe(false);
  });
});
