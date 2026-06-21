import { describe, expect, it } from "vitest";
import { mondayOfLocalDate, weekWindowForLocalDate, isInWeek } from "./week";

/** #329 — the ONE Monday-anchored week definition (pure, DST-safe calendar math). */

describe("mondayOfLocalDate", () => {
  it("a mid-week day maps to its Monday", () => {
    // 2026-06-22 is a Monday; 2026-06-24 (Wed) → 2026-06-22
    expect(mondayOfLocalDate("2026-06-24")).toBe("2026-06-22");
    expect(mondayOfLocalDate("2026-06-22")).toBe("2026-06-22");
  });
  it("a Sunday belongs to the week that started the previous Monday", () => {
    expect(mondayOfLocalDate("2026-06-28")).toBe("2026-06-22"); // Sun → prior Mon
  });
  it("handles month/year boundaries", () => {
    expect(mondayOfLocalDate("2026-01-01")).toBe("2025-12-29"); // Thu → Mon in Dec
  });
  it("rejects a non-ISO date", () => {
    expect(() => mondayOfLocalDate("22/06/2026")).toThrow();
  });
});

describe("weekWindowForLocalDate", () => {
  it("returns Mon→Sun with all seven days", () => {
    const w = weekWindowForLocalDate("2026-06-24");
    expect(w.monday).toBe("2026-06-22");
    expect(w.sunday).toBe("2026-06-28");
    expect(w.days).toEqual([
      "2026-06-22",
      "2026-06-23",
      "2026-06-24",
      "2026-06-25",
      "2026-06-26",
      "2026-06-27",
      "2026-06-28",
    ]);
  });
});

describe("isInWeek", () => {
  const w = weekWindowForLocalDate("2026-06-24");
  it("inclusive of Monday and Sunday; excludes neighbours", () => {
    expect(isInWeek("2026-06-22", w)).toBe(true);
    expect(isInWeek("2026-06-28", w)).toBe(true);
    expect(isInWeek("2026-06-21", w)).toBe(false); // prev Sunday
    expect(isInWeek("2026-06-29", w)).toBe(false); // next Monday
  });
});
