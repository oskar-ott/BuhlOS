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
function render(entries: TimeEntry[], todayISO = TODAY, selectedDate?: string) {
  return renderToString(createElement(PhilWeekStrip, { entries, todayISO, selectedDate }));
}

/** The opening <a> tag for the cell linking to a given date (so we can assert
 *  attributes like aria-current without depending on hashed module classes). */
function dayAnchor(html: string, date: string): string {
  const hrefAt = html.indexOf(`fixDate=${date}`);
  if (hrefAt < 0) return "";
  const start = html.lastIndexOf("<a", hrefAt);
  const end = html.indexOf(">", hrefAt);
  return html.slice(start, end + 1);
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

  it("shows a rejected day as fix — the worker can see it needs their hand", () => {
    const html = render([
      { date: "2024-05-20", totalHours: 7.6, status: "rejected" } as unknown as TimeEntry,
      { date: "2024-05-21", totalHours: 7.6, status: "approved" } as unknown as TimeEntry,
    ]);
    expect(html).toContain("fix");
    expect(html).toContain("approved");
  });

  it("links today + past days to the hours form for that date; future days stay inert", () => {
    const html = render([entry("2024-05-20", 7.6)]);
    // Mon (logged) … Fri (today) are all tappable directory entries.
    expect(html).toContain('href="/phil/my-day?fixDate=2024-05-20"');
    expect(html).toContain('href="/phil/my-day?fixDate=2024-05-23"');
    expect(html).toContain('href="/phil/my-day?fixDate=2024-05-24"');
    // Sat/Sun are still ahead of (Friday) today — nothing to act on, no link.
    expect(html).not.toContain("fixDate=2024-05-25");
    expect(html).not.toContain("fixDate=2024-05-26");
  });

  it("labels a missed day with a log prompt and a rejected day with a fix prompt", () => {
    const html = render([
      { date: "2024-05-20", totalHours: 7.6, status: "rejected" } as unknown as TimeEntry,
    ]);
    // Thu 2024-05-23 is a past weekday with no entry.
    expect(html).toContain("not logged. Log hours for this day.");
    expect(html).toContain("rejected. Fix and resubmit this day.");
  });

  it("paints the SHORT 'miss' chip for a missed day (the full words overflow the cell), keeping the full word in the aria-label", () => {
    // Thu 2024-05-23 is a past weekday with no entry → a missed day.
    const html = render([entry("2024-05-20", 7.6)]);
    expect(html).toContain("miss"); // the short visible chip (was the too-wide "not logged")
    // the full semantic word is preserved for screen readers in the tap label
    expect(html).toContain("not logged. Log hours for this day.");
  });

  it("highlights TODAY by default (aria-current on today, not on a past day)", () => {
    const html = render([entry("2024-05-20", 7.6)]); // no selectedDate → defaults to today
    expect(dayAnchor(html, "2024-05-24")).toContain('aria-current="date"'); // Fri = today
    expect(dayAnchor(html, "2024-05-20")).not.toContain('aria-current="date"'); // Mon
    expect((html.match(/aria-current="date"/g) ?? []).length).toBe(1); // exactly one selected
  });

  it("moves the highlight to the SELECTED day when a fixDate is open (so the date change is visible)", () => {
    const html = render([entry("2024-05-20", 7.6)], TODAY, "2024-05-20"); // editing Monday
    expect(dayAnchor(html, "2024-05-20")).toContain('aria-current="date"'); // ring follows Mon
    expect(dayAnchor(html, "2024-05-24")).not.toContain('aria-current="date"'); // today no longer ringed
    expect((html.match(/aria-current="date"/g) ?? []).length).toBe(1);
  });

  it("a logged day shows its hours number, not a redundant status WORD in the chip", () => {
    // Mon 2024-05-20 approved → the chip is the number; the word stays in the aria-label only.
    const html = render([
      { date: "2024-05-20", totalHours: 7.6, status: "approved" } as unknown as TimeEntry,
    ]);
    expect(html).toContain("7.6"); // the number is the chip content for a logged day
    expect(html).toContain("approved. Open this day in the hours form."); // word kept for a11y
  });
});
