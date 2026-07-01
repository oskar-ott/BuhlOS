import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// The surface uses useRouter for post-mutation refresh; stub it for SSR.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { WeeklyHoursApprovalMobile } from "./WeeklyHoursApprovalMobile";
import { buildWeeklyHoursCloseout } from "@/domains/timesheets/weekly-closeout";
import type { MissingLog, TimeEntry } from "@/domains/timesheets/types";

// Pinned week: Monday 2024-05-20 … Sunday 2024-05-26; today = Friday 2024-05-24.
const WEEK_START = "2024-05-20";
const TODAY = "2024-05-24";

const WEEK_NAV = {
  prevWeek: "2024-05-13",
  nextWeek: "2024-05-27",
  currentWeek: "2024-05-20",
  isCurrentWeek: true,
};

function entry(
  p: Partial<TimeEntry> & { userId: string; date: string; userName: string },
): TimeEntry {
  return {
    id: `te_${p.userId}_${p.date}`,
    userRole: "Electrician",
    totalHours: 8,
    ordinaryHours: 8,
    overtimeHours: 0,
    status: "approved",
    rejectedReason: null,
    notes: null,
    allocations: [{ jobId: "j1", jobName: "UTS Building 11", hours: p.totalHours ?? 8 }],
    ...p,
  } as unknown as TimeEntry;
}

/** Strip React's SSR text-boundary comments so interpolated strings like
 *  "2.5 OT" / "Waiting on Rhys" assert as the user reads them. */
const strip = (html: string) => html.replace(/<!-- -->/g, "");

function render(entries: TimeEntry[], missing: MissingLog[] = [], canUndo = true) {
  const closeout = buildWeeklyHoursCloseout({
    entries,
    missing,
    weekStart: WEEK_START,
    todayISO: TODAY,
  });
  return strip(
    renderToString(
      createElement(WeeklyHoursApprovalMobile, {
        closeout,
        weekNav: WEEK_NAV,
        canUndo,
        fetchError: null,
      }),
    ),
  );
}

/**
 * SSR smoke for the phone weekly-approval surface. The band/summary rules live
 * in weekly-approval-mobile.test.ts — this pins what the BOSS actually sees on
 * the phone: the summary readout, the guided review CTA, per-person cards with
 * real approve/query actions, an honest waiting list (NO fake nudge), and
 * honest empties.
 */
describe("WeeklyHoursApprovalMobile (render)", () => {
  it("leads with the pay-run header + summary readout", () => {
    const html = render([
      entry({ userId: "u1", date: "2024-05-20", userName: "Ari Boland", totalHours: 8 }),
      entry({ userId: "u2", date: "2024-05-20", userName: "Rhys Kelly", status: "submitted", totalHours: 8 }),
    ]);
    expect(html).toContain("Weekly hours");
    expect(html).toContain("Pay run");
    // Summary progress: 1 of 2 weeks ready (u1 approved, u2 submitted) = 50%.
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain("of 2 approved");
    // Segment labels.
    expect(html).toContain("Logged");
    expect(html).toContain("Overtime");
  });

  it("offers the guided 'Review each' stepper, naming the pending count", () => {
    const html = render([
      entry({ userId: "u1", date: "2024-05-20", userName: "Ari Boland", status: "submitted" }),
      entry({ userId: "u2", date: "2024-05-20", userName: "Rhys Kelly", status: "submitted" }),
    ]);
    expect(html).toContain("Review each");
    expect(html).toContain("Step through 2 weeks");
    expect(html).toContain("data-testid=\"wha-review-each\"");
  });

  it("shows 'Week reviewed' (not the stepper) when nothing is pending", () => {
    const html = render([
      entry({ userId: "u1", date: "2024-05-20", userName: "Ari Boland", status: "approved" }),
    ]);
    expect(html).toContain("Week reviewed");
    expect(html).not.toContain("Step through");
  });

  it("gives a submitted week inline Approve + Query, under 'To approve'", () => {
    const html = render([
      entry({ userId: "u1", date: "2024-05-20", userName: "Rhys Kelly", status: "submitted" }),
    ]);
    expect(html).toContain("To approve");
    expect(html).toContain("Approve");
    expect(html).toContain("Query");
    expect(html).toContain("Rhys Kelly");
  });

  it("flags an overtime week with an OT pill; a clean week reads 'no OT'", () => {
    const otHtml = render([
      entry({
        userId: "u1",
        date: "2024-05-20",
        userName: "Rhys Kelly",
        status: "submitted",
        totalHours: 10.5,
        ordinaryHours: 8,
        overtimeHours: 2.5,
      }),
    ]);
    expect(otHtml).toContain("2.5 OT");

    const cleanHtml = render([
      entry({ userId: "u1", date: "2024-05-20", userName: "Ari Boland", status: "submitted", totalHours: 8 }),
    ]);
    expect(cleanHtml).toContain("no OT");
  });

  it("shows an approved week as settled, with its approved hours", () => {
    const html = render([
      entry({ userId: "u1", date: "2024-05-20", userName: "Dave Tran", status: "approved", totalHours: 8 }),
    ]);
    // Its own "Approved" section, and the approved total (formatHoursLabel → 8h).
    expect(html).toContain("Dave Tran");
    expect(html).toContain("8h");
  });

  it("lists a rejected week as waiting on the worker — reason shown, NO approve, NO fake nudge", () => {
    const html = render([
      entry({
        userId: "u1",
        date: "2024-05-20",
        userName: "Rhys Kelly",
        status: "rejected",
        rejectedReason: "Wrong job",
      }),
    ]);
    expect(html).toContain("Not ready yet");
    expect(html).toContain("Sent back");
    expect(html).toContain("Waiting on Rhys");
    // P7: the phone never fakes a reminder/nudge backend.
    expect(html).not.toContain("Nudge");
    // A rejected week is not approvable here — no inline Approve control.
    expect(html).not.toContain(">Approve<");
  });

  it("names the desktop-only home of payroll export (honest boundary)", () => {
    const html = render([
      entry({ userId: "u1", date: "2024-05-20", userName: "Ari Boland", status: "submitted" }),
    ]);
    expect(html).toContain("Payroll export and the");
    expect(html).toContain("BuhlOS on desktop");
  });

  it("is honestly empty when the week has no entries and no missing days", () => {
    const html = render([]);
    expect(html).toContain("No hours this week");
    expect(html).not.toContain("To approve");
  });

  it("surfaces a fetch error banner instead of pretending the week loaded", () => {
    const closeout = buildWeeklyHoursCloseout({
      entries: [],
      missing: [],
      weekStart: WEEK_START,
      todayISO: TODAY,
    });
    const html = strip(
      renderToString(
        createElement(WeeklyHoursApprovalMobile, {
          closeout,
          weekNav: WEEK_NAV,
          canUndo: true,
          fetchError: "API returned 500",
        }),
      ),
    );
    expect(html).toContain("Couldn");
    expect(html).toContain("API returned 500");
  });
});
