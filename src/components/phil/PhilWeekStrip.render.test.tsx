import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilWeekStrip } from "./PhilWeekStrip";
import type { TimeEntry } from "@/domains/timesheets/types";

// Friday 2024-05-24 — ISO week 21 (Mon 2024-05-20 … Sun 2024-05-26).
const TODAY = "2024-05-24";
function entry(date: string, totalHours: number): TimeEntry {
  return { date, totalHours } as unknown as TimeEntry;
}
function render(entries: TimeEntry[], todayISO = TODAY) {
  return renderToString(createElement(PhilWeekStrip, { entries, todayISO }));
}

/**
 * Structure smoke for the design-faithful "This week" strip. Asserts on text
 * (not the scoped module class names): the seven weekday labels, the real week
 * range/total, the honest "log now" prompt, and the history link.
 */
describe("PhilWeekStrip (render)", () => {
  it("renders the seven weekday labels, the week range and a history link", () => {
    const html = render([entry("2024-05-20", 7.6), entry("2024-05-22", 8.2)]);
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
      expect(html).toContain(d);
    }
    expect(html).toContain("This week");
    expect(html).toContain("wk 21");
    expect(html).toContain("/phil/hours");
  });

  it("shows real logged hours + the week total, and flags today unlogged", () => {
    const html = render([entry("2024-05-20", 7.6), entry("2024-05-21", 7.6)]);
    expect(html).toContain("7.6");
    expect(html).toContain("15.2h"); // real sum, not fabricated
    expect(html).toContain("Today not logged"); // Friday (today) has no entry
  });

  it("prompts to log when today is empty (honest, not a guessed value)", () => {
    const html = render([]);
    expect(html).toContain("log now");
    expect(html).toContain("0.0h");
  });
});
