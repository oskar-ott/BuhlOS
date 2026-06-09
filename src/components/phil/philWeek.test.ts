import { describe, expect, it } from "vitest";
import { buildPhilWeek, isoWeekNumber } from "./philWeek";

// A pinned week: Monday 2024-05-20 … Sunday 2024-05-26, with today = Friday
// 2024-05-24. This is ISO week 21 (Monday of week 21 of 2024 is 2024-05-20).
const TODAY = "2024-05-24";
const WEEK = [
  { date: "2024-05-20", totalHours: 7.6 }, // Mon
  { date: "2024-05-21", totalHours: 7.6 }, // Tue
  { date: "2024-05-22", totalHours: 8.2 }, // Wed
  { date: "2024-05-23", totalHours: 7.6 }, // Thu
];

describe("isoWeekNumber", () => {
  it("computes the ISO week (Monday of wk 21, 2024 is 2024-05-20)", () => {
    expect(isoWeekNumber("2024-05-20")).toBe(21);
    expect(isoWeekNumber("2024-05-26")).toBe(21); // Sunday, same ISO week
    expect(isoWeekNumber("2024-01-01")).toBe(1);
  });
});

describe("buildPhilWeek", () => {
  it("builds Mon–Sun from real entries with the right states and total", () => {
    const w = buildPhilWeek(WEEK, { todayISO: TODAY });
    expect(w.weekStart).toBe("2024-05-20");
    expect(w.weekEnd).toBe("2024-05-26");
    expect(w.weekNumber).toBe(21);
    expect(w.days).toHaveLength(7);
    expect(w.days.map((d) => d.weekday)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);

    // Mon–Thu are logged with their real hours.
    expect(w.days[0]).toMatchObject({ state: "logged", hours: 7.6, statusWord: "logged" });
    expect(w.days[2]).toMatchObject({ state: "logged", hours: 8.2 });
    // Friday is today, not yet logged → prompts a log.
    expect(w.days[4]).toMatchObject({ date: TODAY, state: "today", hours: null, statusWord: "log now" });
    // Weekend with no entry → off (faded), never "missing".
    expect(w.days[5]).toMatchObject({ state: "off", hours: null });
    expect(w.days[6]).toMatchObject({ state: "off", hours: null });

    expect(w.totalHours).toBeCloseTo(31.0, 5);
    expect(w.todayLogged).toBe(false);
  });

  it("marks a PAST weekday with no entry as missing (a soft nudge, not fake)", () => {
    // Drop Wednesday — a past weekday this week.
    const w = buildPhilWeek(WEEK.filter((e) => e.date !== "2024-05-22"), { todayISO: TODAY });
    expect(w.days[2]).toMatchObject({ state: "miss", hours: null, statusWord: "not logged" });
  });

  it("reflects a logged today and counts it in the total", () => {
    const w = buildPhilWeek([...WEEK, { date: TODAY, totalHours: 8 }], { todayISO: TODAY });
    expect(w.days[4]).toMatchObject({ state: "today", hours: 8, statusWord: "today" });
    expect(w.todayLogged).toBe(true);
    expect(w.totalHours).toBeCloseTo(39.0, 5);
  });

  it("never fabricates hours — a day with no entry is null", () => {
    const w = buildPhilWeek([], { todayISO: TODAY });
    expect(w.totalHours).toBe(0);
    expect(w.days.every((d) => d.hours === null)).toBe(true);
    // a future WEEKDAY in the week reads as upcoming; a future weekend as off
    const monday = buildPhilWeek([], { todayISO: "2024-05-20" });
    expect(monday.days[4]).toMatchObject({ state: "upcoming" }); // Fri is future when today is Mon
    expect(monday.days[5]).toMatchObject({ state: "off" }); // Sat
  });
});
