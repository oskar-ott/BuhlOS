import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// The wizard uses useRouter for the debounced post-action refresh; stub it.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { WeeklyCloseoutWizard, closeoutDoneSummary } from "./WeeklyCloseoutWizard";
import { buildWeeklyHoursCloseout } from "@/domains/timesheets/weekly-closeout";
import type { MissingLog, TimeEntry } from "@/domains/timesheets/types";

// Pinned week: Monday 2024-05-20 … Sunday 2024-05-26; today = Friday 2024-05-24.
const WEEK_START = "2024-05-20";
const TODAY = "2024-05-27"; // the following Monday — the viewed week has ENDED (missing days are real)
const WEEK_LABEL = "Mon 20 May – Sun 26 May";

function entry(p: Partial<TimeEntry> & { userId: string; date: string; userName: string }): TimeEntry {
  return {
    id: `te_${p.userId}_${p.date}`,
    userRole: "Electrician",
    totalHours: 8,
    ordinaryHours: 8,
    overtimeHours: 0,
    status: "submitted",
    rejectedReason: null,
    notes: null,
    allocations: [{ jobId: "j1", jobName: "100 Arthur", hours: p.totalHours ?? 8 }],
    ...p,
  } as unknown as TimeEntry;
}

function render(entries: TimeEntry[], missing: MissingLog[] = []) {
  const closeout = buildWeeklyHoursCloseout({
    entries,
    missing,
    weekStart: WEEK_START,
    todayISO: TODAY,
  });
  return renderToString(
    createElement(WeeklyCloseoutWizard, {
      closeout,
      weekLabel: WEEK_LABEL,
      canUndo: true,
      onClose: () => {},
    }),
  ).replace(/<!-- -->/g, ""); // strip SSR text-node separators for phrase asserts
}

/**
 * SSR smoke for the desktop weekly-closeout wizard (lean-reset redesign).
 * The stepper's derivations (queue, status words, day notes, ord/OT split)
 * are unit-tested in weekly-review.test.ts — this pins what the modal shows
 * on open: header + progress, the first worker's card, the honest day rows,
 * and the right footer for submitted vs nothing-submitted weeks.
 */
describe("WeeklyCloseoutWizard (render)", () => {
  it("opens on the header, progress and the FIRST worker in queue order", () => {
    const html = render([
      entry({ userId: "u1", date: "2024-05-20", userName: "Tom Brown", status: "approved" }),
      entry({ userId: "u2", date: "2024-05-20", userName: "Jack Smith", status: "submitted" }),
    ]);
    expect(html).toContain('data-testid="closeout-wizard"');
    expect(html).toContain("Weekly closeout · " + WEEK_LABEL);
    expect(html).toContain("Review each week");
    expect(html).toContain("1 of 2");
    // Queue order = model order: the submitted (needs-review) week first.
    expect(html).toContain("Jack Smith");
    expect(html).not.toContain("Tom Brown");
  });

  it("shows the ordinary/overtime blocks and the amber overtime warning", () => {
    const html = render([
      entry({
        userId: "u1",
        date: "2024-05-20",
        userName: "Jack Smith",
        totalHours: 10.5,
        ordinaryHours: 8,
        overtimeHours: 2.5,
        allocations: [{ jobId: "j1", jobName: "100 Arthur", hours: 10.5 }],
      }),
    ]);
    expect(html).toContain("Ordinary");
    expect(html).toContain("Overtime");
    expect(html).toContain("8h"); // ordinary block
    expect(html).toContain("2h 30m"); // overtime block
    expect(html).toContain("Approving includes the overtime.");
  });

  it("renders Day by day with the jobs and Booked to chips", () => {
    const html = render([
      entry({ userId: "u1", date: "2024-05-20", userName: "Jack Smith" }),
      entry({ userId: "u1", date: "2024-05-21", userName: "Jack Smith" }),
    ]);
    expect(html).toContain("Day by day");
    expect(html).toContain("100 Arthur");
    expect(html).toContain("Booked to");
    // 1 day to approve? no — 2 submitted days → the status word names them.
    expect(html).toContain("2 days to approve");
  });

  it("footer offers Send back + 'Approve all · Nh' for a week with submitted days", () => {
    const html = render([
      entry({ userId: "u1", date: "2024-05-20", userName: "Jack Smith", totalHours: 8.5 }),
    ]);
    expect(html).toContain('data-testid="closeout-wizard-approve"');
    expect(html).toContain('data-testid="closeout-wizard-reject"');
    // One word for the action across the office surfaces (2026-09-26 audit).
    expect(html).toContain(">Send back<");
    expect(html).not.toContain(">Reject<");
    // Approve names the SUBMITTED hours, never overstating the tap.
    expect(html).toContain("Approve all · 8h 30m");
  });

  it("a nothing-submitted week shows honest day notes and 'Next →' instead of Approve", () => {
    const html = render(
      [],
      [{ userId: "u3", date: "2024-05-21", userName: "Josh Mason", role: "tradie" } as MissingLog],
    );
    expect(html).toContain("Josh Mason");
    expect(html).toContain("No hours logged this week");
    expect(html).toContain("Missing"); // the flagged Tuesday
    expect(html).toContain("Not on"); // untracked past weekdays
    expect(html).toContain('data-testid="closeout-wizard-next"');
    expect(html).not.toContain('data-testid="closeout-wizard-approve"');
  });

  it("progress bar starts empty (w-0) — honest, no pre-claimed progress", () => {
    const html = render([
      entry({ userId: "u1", date: "2024-05-20", userName: "Jack Smith" }),
    ]);
    expect(html).toContain('aria-valuenow="0"');
  });
});

/**
 * The done screen is unreachable under SSR (it needs the stepper walked), so
 * its words are pinned as a pure function: it counts only approvals that
 * LANDED, and a failure is never folded into "every week is cleared"
 * (2026-09-26 audit — the stepper used to advance before the server answered).
 */
describe("closeoutDoneSummary", () => {
  it("all landed → N of N approved, pointing at the pay period", () => {
    const s = closeoutDoneSummary({ total: 3, approved: 3, sentBack: 0, failed: 0 });
    expect(s.headline).toBe("3 of 3 weeks approved");
    expect(s.failed).toBe(0);
    expect(s.detail).toContain("pay period");
  });

  it("names weeks sent back without calling them cleared", () => {
    const s = closeoutDoneSummary({ total: 3, approved: 2, sentBack: 1, failed: 0 });
    expect(s.headline).toBe("2 of 3 weeks approved");
    expect(s.detail).toContain("1 week sent back to the worker");
  });

  it("a failed approval is said plainly and counted out of the approved figure", () => {
    const s = closeoutDoneSummary({ total: 2, approved: 1, sentBack: 0, failed: 1 });
    expect(s.headline).toBe("1 of 2 weeks approved");
    expect(s.failed).toBe(1);
    expect(s.detail).toContain("1 week couldn't be approved or sent back");
    expect(s.detail).not.toContain("Every submitted week");
  });
});
