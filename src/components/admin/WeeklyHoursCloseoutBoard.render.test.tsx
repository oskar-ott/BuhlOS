import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// The board uses useRouter for post-mutation refresh; stub it for SSR.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { WeeklyHoursCloseoutBoard } from "./WeeklyHoursCloseoutBoard";
import { buildWeeklyHoursCloseout } from "@/domains/timesheets/weekly-closeout";
import type { MissingLog, TimeEntry } from "@/domains/timesheets/types";

// Pinned week: Monday 2024-05-20 … Sunday 2024-05-26; today = Friday 2024-05-24.
const WEEK_START = "2024-05-20";
const TODAY = "2024-05-24";

function entry(p: Partial<TimeEntry> & { userId: string; date: string; userName: string }): TimeEntry {
  return {
    id: `te_${p.userId}_${p.date}`,
    userRole: "tradie",
    totalHours: 7.6,
    status: "approved",
    rejectedReason: null,
    notes: null,
    allocations: [{ jobId: "j1", jobName: "100 Arthur", hours: p.totalHours ?? 7.6 }],
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
    createElement(WeeklyHoursCloseoutBoard, { closeout, fetchError: null })
  );
}

function renderAsAdmin(entries: TimeEntry[], missing: MissingLog[] = []) {
  const closeout = buildWeeklyHoursCloseout({
    entries,
    missing,
    weekStart: WEEK_START,
    todayISO: TODAY,
  });
  return renderToString(
    createElement(WeeklyHoursCloseoutBoard, { closeout, fetchError: null, canUndo: true })
  );
}

/**
 * SSR smoke for the /hours/weekly decision board. The derivation rules live in
 * weekly-closeout.test.ts — this pins what the BOSS actually sees: readiness
 * first, needing-action before ready, real actions on submitted days, honest
 * empties, and no fabricated rows.
 */
describe("WeeklyHoursCloseoutBoard (render)", () => {
  it("leads with the pay-run hero, approval progress and the week's counts", () => {
    const html = render([
      entry({ userId: "u1", date: "2024-05-20", userName: "Tom Brown" }),
      entry({ userId: "u2", date: "2024-05-20", userName: "Jack Smith", status: "submitted" }),
    ]);
    expect(html).toContain("Pay run");
    expect(html).toContain("Not payroll-ready");
    expect(html).toContain("1 ready");
    // The hero reframes "need action" as the flagged "need a look" count
    // (0 here — the one open week is clean/submitted), and shows progress.
    expect(html).toContain("0 need a look");
    expect(html).toContain("1 of 2 workers approved");
    expect(html).toContain("1 submitted day");
  });

  it("offers a clean-sweep button for weeks whose only open state is submitted", () => {
    const html = render([
      entry({ userId: "u1", date: "2024-05-20", userName: "Jack Smith", status: "submitted" }),
    ]);
    expect(html).toContain("Approve all clean");
  });

  it("renders the seven-day shape strip per worker", () => {
    const html = render([
      entry({ userId: "u1", date: "2024-05-20", userName: "Jack Smith", status: "submitted" }),
    ]);
    expect(html).toContain("week at a glance");
    expect(html).toContain("Week strip"); // the legend heading
  });

  it("groups workers needing action before the payroll-ready group", () => {
    const html = render([
      entry({ userId: "u_ready", date: "2024-05-20", userName: "Tom Brown" }),
      entry({ userId: "u_review", date: "2024-05-21", userName: "Jack Smith", status: "submitted" }),
    ]);
    expect(html.indexOf("Needs action")).toBeLessThan(html.indexOf("Ready for payroll"));
    expect(html.indexOf("Jack Smith")).toBeLessThan(html.indexOf("Tom Brown"));
    expect(html).toContain("Needs review");
  });

  it("gives a submitted day Approve and Reject actions", () => {
    const html = render([
      entry({ userId: "u1", date: "2024-05-21", userName: "Jack Smith", status: "submitted" }),
    ]);
    expect(html).toContain("Submitted");
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
  });

  it("shows a rejected day as waiting for the worker, with the reason", () => {
    const html = render([
      entry({
        userId: "u1",
        date: "2024-05-21",
        userName: "Oskar Ott",
        status: "rejected",
        rejectedReason: "Wrong job",
      }),
    ]);
    expect(html).toContain("Waiting for worker");
    expect(html).toContain("Reason: Wrong job");
    // Rejected days are the worker's move — no approve button on them.
    expect(html).not.toContain("Approve");
  });

  it("shows server-flagged missing days and blocking lines", () => {
    const html = render(
      [entry({ userId: "u1", date: "2024-05-20", userName: "Oskar Ott" })],
      [{ date: "2024-05-22", userId: "u1", userName: "Oskar Ott", role: "tradie" } as MissingLog]
    );
    expect(html).toContain("Missing hours");
    expect(html).toContain("Missing");
    expect(html).toContain("Blocking payroll:");
    expect(html).toContain("Wed missing");
  });

  it("totals approved hours per worker and per job", () => {
    const html = render([
      entry({ userId: "u1", date: "2024-05-20", userName: "Tom Brown", totalHours: 7.6 }),
      entry({ userId: "u1", date: "2024-05-21", userName: "Tom Brown", totalHours: 7.6 }),
    ]);
    expect(html).toContain("15h 12m"); // 15.2h approved
    expect(html).toContain("100 Arthur");
    expect(html).toContain("Ready");
  });

  it("is honestly empty when the week has no entries and no missing days", () => {
    const html = render([]);
    expect(html).toContain("No hours found for this week");
    expect(html).not.toContain("Needs action");
    expect(html).not.toContain("Ready for payroll");
  });

  it("never fabricates missing days the server didn't flag", () => {
    // Whole week of approved days only — Mon–Thu logged, Fri (today) not,
    // but the server flagged nothing → no "Missing" anywhere.
    const html = render([
      entry({ userId: "u1", date: "2024-05-20", userName: "Tom Brown" }),
    ]);
    expect(html).not.toContain("Missing");
  });
});

describe("Overtime split display (#130)", () => {
  it("shows the base/OT split on a day with stored overtime (expanded day row)", () => {
    // A submitted day lands the worker in the expanded "Needs action" band,
    // where the per-day rows (and the split) render.
    const html = render([
      entry({
        userId: "u1",
        date: "2024-05-20",
        userName: "Tom Brown",
        status: "submitted",
        totalHours: 10,
        ordinaryHours: 8,
        overtimeHours: 2,
        allocations: [{ jobId: "j1", jobName: "100 Arthur", hours: 10 }],
      }),
    ]);
    expect(html).toContain("8h + 2h OT");
  });

  it("adds no split for a standard day (byte-identical, zero noise)", () => {
    const html = render([
      entry({
        userId: "u1",
        date: "2024-05-20",
        userName: "Tom Brown",
        status: "submitted",
        totalHours: 7.6,
        ordinaryHours: 7.6,
        overtimeHours: 0,
      }),
    ]);
    expect(html).not.toContain(" OT");
  });

  it("HONESTY GUARD: an inconsistent stored split shows total only, no invented split", () => {
    const html = render([
      entry({
        userId: "u1",
        date: "2024-05-20",
        userName: "Tom Brown",
        status: "submitted",
        totalHours: 12,
        ordinaryHours: 8,
        overtimeHours: 2, // 8 + 2 != 12 → garbage
        allocations: [{ jobId: "j1", jobName: "100 Arthur", hours: 12 }],
      }),
    ]);
    expect(html).not.toContain(" OT");
  });
});

describe("Approve week (#124)", () => {
  it("offers Approve week on a worker with submitted days, naming the count", () => {
    const html = render([
      entry({ userId: "u1", userName: "Sam", date: "2024-05-20", status: "submitted" }),
      entry({ userId: "u1", userName: "Sam", date: "2024-05-21", status: "submitted" }),
      entry({ userId: "u1", userName: "Sam", date: "2024-05-22", status: "approved" }),
    ]);
    expect(html).toContain("Approve week (2)");
  });

  it("hides Approve week when the worker has nothing submitted", () => {
    const html = render([
      entry({ userId: "u1", userName: "Sam", date: "2024-05-20", status: "rejected", rejectedReason: "x" }),
    ]);
    expect(html).not.toContain("Approve week");
  });
});

describe("Reopen (#125)", () => {
  it("offers Reopen on approved and rejected days for an admin-tier viewer", () => {
    const html = renderAsAdmin([
      entry({ userId: "u1", userName: "Sam", date: "2024-05-20", status: "approved" }),
      entry({ userId: "u1", userName: "Sam", date: "2024-05-21", status: "rejected", rejectedReason: "wrong job" }),
    ]);
    expect((html.match(/Reopen/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("never offers Reopen to a viewer who can't reopen (no button that 403s)", () => {
    const html = render([
      entry({ userId: "u1", userName: "Sam", date: "2024-05-20", status: "approved" }),
    ]);
    expect(html).not.toContain("Reopen");
  });

  it("never offers Reopen on submitted or missing days", () => {
    const html = renderAsAdmin([
      entry({ userId: "u1", userName: "Sam", date: "2024-05-20", status: "submitted" }),
    ]);
    expect(html).not.toContain("Reopen");
  });
});

describe("Mark not worked (#127)", () => {
  const missingLog = {
    userId: "u_jake",
    userName: "Jake",
    date: "2024-05-21", // a past weekday in the pinned week
    role: "tradie",
  } as unknown as MissingLog;

  function renderWithLeave(opts: {
    missing?: MissingLog[];
    leave?: Array<{ date: string; userId: string; type: string }>;
  }) {
    const closeout = buildWeeklyHoursCloseout({
      entries: [],
      missing: opts.missing ?? [],
      weekStart: WEEK_START,
      todayISO: TODAY,
      leave: opts.leave,
    });
    return renderToString(
      createElement(WeeklyHoursCloseoutBoard, { closeout, fetchError: null, canUndo: true })
    );
  }

  it("a missing day offers 'Mark not worked'", () => {
    const html = renderWithLeave({ missing: [missingLog] });
    expect(html).toContain("mark-not-worked");
    expect(html).toContain("Mark not worked");
  });

  it("a marked (leave) day offers 'Undo' and renders the worker — never vanishes", () => {
    // Same worker, the day now covered by approved leave (no longer missing).
    const html = renderWithLeave({
      leave: [{ date: "2024-05-21", userId: "u_jake", type: "sick" }],
      // Jake stays in the worker universe via a missing log on ANOTHER day so
      // the board still lists him; his leave day shows Undo. (The overview
      // keeps a partially-on-leave worker visible by construction.)
      missing: [{ ...missingLog, date: "2024-05-22" }] as unknown as MissingLog[],
    });
    expect(html).toContain("Jake");
    expect(html).toContain("undo-not-worked");
  });
});

