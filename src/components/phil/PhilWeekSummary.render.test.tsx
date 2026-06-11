import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilWeekSummary } from "./PhilWeekSummary";
import type { TimeEntry } from "@/domains/timesheets/types";

// Pinned week: Monday 2024-05-20 … Sunday 2024-05-26; today = Friday 2024-05-24.
const TODAY = "2024-05-24";

function entry(date: string, status: TimeEntry["status"], totalHours = 7.6): TimeEntry {
  return { date, totalHours, status } as unknown as TimeEntry;
}

function render(entries: TimeEntry[], todayISO = TODAY) {
  return renderToString(createElement(PhilWeekSummary, { entries, todayISO }));
}

/**
 * SSR smoke for the worker's "This week" summary on /phil/hours. Worker words
 * only (no payroll/admin language); every row real; Fix/Log actions deep-link
 * into the My Day ?fixDate= flow.
 */
describe("PhilWeekSummary (render)", () => {
  it("shows approved as locked-in, submitted as waiting, with the week verdict", () => {
    const html = render([
      entry("2024-05-20", "approved"),
      entry("2024-05-21", "submitted"),
      entry("2024-05-24", "approved", 8),
    ]);
    expect(html).toContain("This week");
    expect(html).toContain("Approved");
    expect(html).toContain("Waiting for approval");
    // verdict: nothing to fix/log besides past gaps? Wed+Thu are unlogged
    // past weekdays → needs action, honestly.
    expect(html).toContain("Needs action");
    // approved tally is real: 7.6 + 8 = 15.6 → "15h 36m"
    expect(html).toContain("15h 36m");
  });

  it("gives a rejected day its reason-side action: Fix → My Day fixDate deep link", () => {
    const html = render([
      entry("2024-05-20", "approved"),
      entry("2024-05-21", "rejected"),
    ]);
    expect(html).toContain("Rejected — fix needed");
    expect(html).toContain("/phil/my-day?fixDate=2024-05-21");
    expect(html).toContain("Fix");
  });

  it("offers Log only for honestly-missing past weekdays, never future days", () => {
    // Today is Monday — every other weekday is future.
    const html = render([], "2024-05-20");
    expect(html).toContain("Not logged yet"); // today’s own prompt
    expect(html).toContain("Log today");
    // No bare "Log" action for any future day — only today's prompt exists.
    expect(html).not.toContain(">Log<");
    // Future weekdays render as muted dashes, not missing.
    expect(html).not.toContain("Rejected");
  });

  it("nudges past unlogged weekdays with a one-tap Log action", () => {
    const html = render([entry("2024-05-20", "approved")]); // Tue–Thu unlogged
    expect(html).toContain("Not logged");
    expect(html).toContain("/phil/my-day?fixDate=2024-05-21");
  });

  it("is calm when everything is approved", () => {
    const html = render(
      [
        entry("2024-05-20", "approved"),
        entry("2024-05-21", "approved"),
      ],
      "2024-05-21",
    );
    expect(html).toContain("All approved");
  });

  it("shows a draft truthfully without a dead-end action", () => {
    const html = render([entry("2024-05-20", "draft")], "2024-05-21");
    expect(html).toContain("Draft — not submitted");
    // No Fix/Log action for drafts — modern Phil has no draft-edit flow.
    expect(html).not.toContain("/phil/my-day?fixDate=2024-05-20");
  });

  it("hides weekends that weren't worked and never uses admin/payroll words", () => {
    const html = render([entry("2024-05-20", "approved")]);
    expect(html).not.toContain("Sat");
    expect(html).not.toContain("Sun");
    expect(html).not.toContain("Payroll");
    expect(html).not.toContain("payroll");
    expect(html).not.toContain("Approve<"); // no admin verbs
  });
});
