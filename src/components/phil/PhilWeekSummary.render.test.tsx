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

/** An entry carrying a stored ordinary/overtime split (#130). */
function otEntry(
  date: string,
  status: TimeEntry["status"],
  totalHours: number,
  ordinaryHours: number,
  overtimeHours: number,
): TimeEntry {
  return { date, status, totalHours, ordinaryHours, overtimeHours } as unknown as TimeEntry;
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

  it("shows the calm 'Week squared away' line only when the whole week is approved (#427)", () => {
    // Today = Tue; Mon+Tue both approved, nothing else loggable yet → all-approved.
    const squared = render(
      [entry("2024-05-20", "approved"), entry("2024-05-21", "approved")],
      "2024-05-21",
    );
    expect(squared).toContain("Week squared away");
    // The existing chip stays — the win is one extra calm line, not a replacement.
    expect(squared).toContain("All approved");

    // A still-waiting entry → no win line (the office hasn't closed the week).
    const waiting = render(
      [entry("2024-05-20", "approved"), entry("2024-05-21", "submitted")],
      "2024-05-21",
    );
    expect(waiting).not.toContain("Week squared away");

    // A nothing-logged week → no win line (P7 honesty gate: total must be real).
    const nothing = render([], "2024-05-20");
    expect(nothing).not.toContain("Week squared away");
  });

  it("shows a draft truthfully without a dead-end action", () => {
    const html = render([entry("2024-05-20", "draft")], "2024-05-21");
    expect(html).toContain("Draft — not submitted");
    // No Fix/Log action for drafts — modern Phil has no draft-edit flow.
    expect(html).not.toContain("/phil/my-day?fixDate=2024-05-20");
  });

  it("shows the overtime a worker worked, in worker words — never 'OT' jargon (#130)", () => {
    // A 10h Monday: 8h ordinary + 2h overtime. Today = Friday so Monday is logged.
    const html = render([otEntry("2024-05-20", "approved", 10, 8, 2)]);
    expect(html).toContain("8h + 2h overtime");
    // Worker words only — never the admin "OT" abbreviation.
    expect(html).not.toContain(" OT");
  });

  it("adds no overtime line on a standard ≤8h day (zero noise, P10)", () => {
    const html = render([otEntry("2024-05-20", "approved", 8, 8, 0)]);
    expect(html).not.toContain("overtime");
  });

  it("HONESTY GUARD: an inconsistent stored split shows no invented overtime line (P7)", () => {
    // 8 + 2 != 12 → the presenter refuses to render a split.
    const html = render([otEntry("2024-05-20", "approved", 12, 8, 2)]);
    expect(html).not.toContain("overtime");
  });

  it("treats a past weekend like a weekday — it's loggable — and never uses admin/payroll words", () => {
    // Today = Sunday 2024-05-26, so Saturday 2024-05-25 just gone.
    const html = render([entry("2024-05-20", "approved")], "2024-05-26");
    // The weekend now appears and a worked Saturday is one tap from logging…
    expect(html).toContain("Sat");
    expect(html).toContain("/phil/my-day?fixDate=2024-05-25");
    // …while the language stays worker-side, never admin/payroll.
    expect(html).not.toContain("Payroll");
    expect(html).not.toContain("payroll");
    expect(html).not.toContain("Approve<"); // no admin verbs
  });
});
