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

/** SSR splits adjacent text nodes with `<!-- -->` — strip them so phrase
 *  assertions ("1 of 2 approved") match what the user actually reads. */
function clean(html: string): string {
  return html.replace(/<!-- -->/g, "");
}

function render(entries: TimeEntry[], missing: MissingLog[] = []) {
  const closeout = buildWeeklyHoursCloseout({
    entries,
    missing,
    weekStart: WEEK_START,
    todayISO: TODAY,
  });
  return clean(
    renderToString(createElement(WeeklyHoursCloseoutBoard, { closeout, fetchError: null }))
  );
}

function renderAsAdmin(entries: TimeEntry[], missing: MissingLog[] = []) {
  const closeout = buildWeeklyHoursCloseout({
    entries,
    missing,
    weekStart: WEEK_START,
    todayISO: TODAY,
  });
  return clean(
    renderToString(
      createElement(WeeklyHoursCloseoutBoard, { closeout, fetchError: null, canUndo: true })
    )
  );
}

/**
 * SSR smoke for the /hours/weekly desktop board (lean-reset redesign). The
 * derivation rules live in weekly-closeout.test.ts — this pins what the BOSS
 * actually sees: the "Week of" card with the wizard trigger, per-worker cards
 * with status chips and in-place actions on submitted days, honest empties,
 * and no fabricated rows.
 */
describe("WeeklyHoursCloseoutBoard (render)", () => {
  it("leads with the Week-of card — range, wizard trigger, progress, clean sweep", () => {
    const html = render([
      entry({ userId: "u1", date: "2024-05-20", userName: "Tom Brown", totalHours: 8 }),
      entry({ userId: "u2", date: "2024-05-20", userName: "Jack Smith", status: "submitted", totalHours: 8 }),
    ]);
    expect(html).toContain("Week of");
    expect(html).toContain('data-testid="start-weekly-closeout"');
    expect(html).toContain("Start weekly closeout");
    // Progress + meta: 16h logged (8 + 8), u1 approved / u2 submitted → 1 of 2.
    expect(html).toContain("16");
    expect(html).toContain("logged");
    expect(html).toContain("1 of 2 approved");
    // The one open week is clean (submitted only) → the sweep is offered.
    expect(html).toContain("Approve all clean");
  });

  it("hides the 'need a look' meta when nothing is flagged (no zero-noise)", () => {
    const html = render([
      entry({ userId: "u1", date: "2024-05-20", userName: "Jack Smith", status: "submitted" }),
    ]);
    expect(html).not.toContain("need a look");
  });

  it("renders the seven-day shape strip per worker", () => {
    const html = render([
      entry({ userId: "u1", date: "2024-05-20", userName: "Jack Smith", status: "submitted" }),
    ]);
    expect(html).toContain("week at a glance");
    expect(html).toContain("Week strip"); // the legend heading
  });

  it("orders workers needing action before the payroll-ready ones", () => {
    const html = render([
      entry({ userId: "u_ready", date: "2024-05-20", userName: "Tom Brown" }),
      entry({ userId: "u_review", date: "2024-05-21", userName: "Jack Smith", status: "submitted" }),
    ]);
    // The model sorts needs-action first, so the submitted worker's card
    // renders above the approved one.
    expect(html.indexOf("Jack Smith")).toBeLessThan(html.indexOf("Tom Brown"));
    // The submitted worker's chip counts the days; the ready one reads Ready.
    expect(html).toContain("1 to approve");
    expect(html).toContain("Ready");
  });

  it("gives a submitted day in-place Approve and ghost-red Reject actions", () => {
    const html = render([
      entry({ userId: "u1", date: "2024-05-21", userName: "Jack Smith", status: "submitted" }),
    ]);
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
    // The single submitted day gets the singular bulk label.
    expect(html).toContain("Approve this day");
  });

  it("labels the bulk action 'Approve all N days' for a multi-day week", () => {
    const html = render([
      entry({ userId: "u1", userName: "Sam", date: "2024-05-20", status: "submitted" }),
      entry({ userId: "u1", userName: "Sam", date: "2024-05-21", status: "submitted" }),
      entry({ userId: "u1", userName: "Sam", date: "2024-05-22", status: "approved" }),
    ]);
    expect(html).toContain("Approve all 2 days");
  });

  it("shows a rejected day as Sent back + waiting for the worker, with the reason", () => {
    const html = render([
      entry({
        userId: "u1",
        date: "2024-05-21",
        userName: "Oskar Ott",
        status: "rejected",
        rejectedReason: "Wrong job",
      }),
    ]);
    expect(html).toContain("Sent back");
    expect(html).toContain("Waiting for worker");
    expect(html).toContain("Reason: Wrong job");
    // Rejected days are the worker's move — no approve action on them.
    expect(html).not.toMatch(/Approve (this day|all \d+ days)/);
  });

  it("flags a server-missing day with the chip + an honest reason + Mark not worked", () => {
    const html = renderAsAdmin(
      [entry({ userId: "u1", date: "2024-05-20", userName: "Oskar Ott" })],
      [{ date: "2024-05-22", userId: "u1", userName: "Oskar Ott", role: "tradie" } as MissingLog]
    );
    expect(html).toContain("Missing hours");
    expect(html).toContain("No entry for Wed");
    expect(html).toContain("mark-not-worked");
  });

  it("totals every worker's LOGGED hours on the card header", () => {
    const html = render([
      entry({ userId: "u1", date: "2024-05-20", userName: "Tom Brown", totalHours: 8 }),
      entry({ userId: "u1", date: "2024-05-21", userName: "Tom Brown", totalHours: 8.5 }),
    ]);
    // 8 + 8.5 = 16.5 → "16h 30m", and the day numbers appear in the strip.
    expect(html).toContain("16h 30m");
    expect(html).toContain(">8.5<"); // a day number in the strip
    expect(html).toContain("Ready");
  });

  it("shows '—' for labour when the worker has no cost rate (never a fake $0)", () => {
    const html = render([
      entry({ userId: "u1", date: "2024-05-20", userName: "Tom Brown", totalHours: 8 }),
    ]);
    // No costRatesByWorker passed → labour is "—", and the Week-of card omits
    // the labour figure entirely (no "$0", no column of dashes).
    expect(html).toContain("—");
    expect(html).not.toContain("labour");
  });

  it("shows labour $ in the Week-of card and the row when a cost rate is supplied", () => {
    const closeout = buildWeeklyHoursCloseout({
      entries: [
        entry({ userId: "u1", date: "2024-05-20", userName: "Tom Brown", totalHours: 10 }),
      ],
      missing: [],
      weekStart: WEEK_START,
      todayISO: TODAY,
      costRatesByWorker: { u1: 5000 }, // $50.00/h loaded cost
    });
    const html = clean(
      renderToString(createElement(WeeklyHoursCloseoutBoard, { closeout, fetchError: null })),
    );
    // 10h × $50 = $500 — shown in the row and summed into the header labour.
    expect(html).toContain("$500");
    expect(html).toContain("labour");
  });

  it("points at the Pay period tab with an honest readiness line", () => {
    const ready = render([
      entry({ userId: "u1", date: "2024-05-20", userName: "Tom Brown" }),
    ]);
    expect(ready).toContain("Payroll export");
    expect(ready).toContain("This week is fully approved.");
    expect(ready).toContain("Open pay period →");

    const notReady = render([
      entry({ userId: "u1", date: "2024-05-20", userName: "Tom Brown", status: "submitted" }),
    ]);
    expect(notReady).toContain("still needs");
  });

  it("is honestly empty when the week has no entries and no missing days", () => {
    const html = render([]);
    expect(html).toContain("No hours found for this week");
    // The wizard has nothing to walk — the trigger is disabled.
    expect(html).toMatch(/data-testid="start-weekly-closeout"[^>]*disabled/);
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
  it("shows the base/OT split on a submitted day with stored overtime", () => {
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

describe("Bulk approve (#124)", () => {
  it("hides the bulk action when the worker has nothing submitted", () => {
    const html = render([
      entry({ userId: "u1", userName: "Sam", date: "2024-05-20", status: "rejected", rejectedReason: "x" }),
    ]);
    expect(html).not.toMatch(/Approve (this day|all \d+ days)/);
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
    return clean(
      renderToString(
        createElement(WeeklyHoursCloseoutBoard, { closeout, fetchError: null, canUndo: true })
      )
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

describe("Week navigation (weekNav prop)", () => {
  it("renders prev/next arrows and a This-week jump for a back-week", () => {
    const closeout = buildWeeklyHoursCloseout({
      entries: [entry({ userId: "u1", date: "2024-05-20", userName: "Tom Brown" })],
      missing: [],
      weekStart: WEEK_START,
      todayISO: TODAY,
    });
    const html = clean(
      renderToString(
        createElement(WeeklyHoursCloseoutBoard, {
          closeout,
          fetchError: null,
          weekNav: {
            prevWeek: "2024-05-13",
            nextWeek: "2024-05-27",
            currentWeek: "2024-05-27",
            isCurrentWeek: false,
          },
        }),
      ),
    );
    expect(html).toContain("Previous week");
    expect(html).toContain("Next week");
    expect(html).toContain("This week");
    expect(html).toContain("week=2024-05-13");
  });
});
