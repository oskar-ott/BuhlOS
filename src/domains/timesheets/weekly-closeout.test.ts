import { describe, expect, it } from "vitest";
import type { MissingLog, TimeEntry } from "./types";
import {
  buildWeeklyHoursCloseout,
  readinessLabel,
  weeklyDayStatusLabel,
} from "./weekly-closeout";

// Pinned week: Monday 2024-05-20 … Sunday 2024-05-26; today = Friday 2024-05-24.
const WEEK_START = "2024-05-20";
const TODAY = "2024-05-24";

function entry(p: Partial<TimeEntry> & { userId: string; date: string }): TimeEntry {
  return {
    id: `te_${p.userId}_${p.date}`,
    userName: p.userId === "u1" ? "Oskar Ott" : p.userId === "u2" ? "Jack Smith" : "Tom Brown",
    userRole: "tradie",
    totalHours: 7.6,
    status: "approved",
    rejectedReason: null,
    notes: null,
    allocations: [{ jobId: "j1", jobName: "100 Arthur", hours: p.totalHours ?? 7.6 }],
    ...p,
  } as unknown as TimeEntry;
}

function missing(userId: string, date: string, userName = "Oskar Ott"): MissingLog {
  return { userId, date, userName, role: "tradie" } as MissingLog;
}

function build(
  entries: TimeEntry[],
  missingLogs: MissingLog[] = [],
  opts: { weekStart?: string; todayISO?: string } = {},
) {
  return buildWeeklyHoursCloseout({
    entries,
    missing: missingLogs,
    weekStart: opts.weekStart ?? WEEK_START,
    todayISO: opts.todayISO ?? TODAY,
  });
}

describe("buildWeeklyHoursCloseout — week shape", () => {
  it("computes the Mon–Sun window and seven day cells per worker", () => {
    const c = build([entry({ userId: "u1", date: "2024-05-20" })]);
    expect(c.weekStart).toBe("2024-05-20");
    expect(c.weekEnd).toBe("2024-05-26");
    expect(c.workers).toHaveLength(1);
    expect(c.workers[0]!.days.map((d) => d.weekday)).toEqual([
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
      "Sun",
    ]);
  });

  it("ignores entries and missing rows outside the week (defensive range filter)", () => {
    const c = build(
      [entry({ userId: "u1", date: "2024-05-13" }), entry({ userId: "u1", date: "2024-05-20" })],
      [missing("u1", "2024-05-15")],
    );
    expect(c.workers[0]!.approvedCount).toBe(1);
    expect(c.workers[0]!.missingCount).toBe(0);
  });

  it("groups entries by worker — only real workers, no fabricated rows", () => {
    const c = build([
      entry({ userId: "u1", date: "2024-05-20" }),
      entry({ userId: "u2", date: "2024-05-20", userName: "Jack Smith" }),
    ]);
    expect(c.workers.map((w) => w.workerId).sort()).toEqual(["u1", "u2"]);
  });
});

describe("buildWeeklyHoursCloseout — totals and counts", () => {
  it("sums approved hours only (rejected/submitted/draft excluded)", () => {
    const c = build([
      entry({ userId: "u1", date: "2024-05-20", status: "approved", totalHours: 7.6 }),
      entry({ userId: "u1", date: "2024-05-21", status: "approved", totalHours: 8 }),
      entry({ userId: "u1", date: "2024-05-22", status: "submitted", totalHours: 7.6 }),
      entry({ userId: "u1", date: "2024-05-23", status: "rejected", totalHours: 9 }),
    ]);
    const w = c.workers[0]!;
    expect(w.approvedHours).toBeCloseTo(15.6, 5);
    expect(w.approvedCount).toBe(2);
    expect(w.submittedCount).toBe(1);
    expect(w.rejectedCount).toBe(1);
    expect(c.summary.approvedHours).toBeCloseTo(15.6, 5);
    expect(c.summary.submittedDays).toBe(1);
    expect(c.summary.rejectedDays).toBe(1);
  });

  it("slices approved hours per job from allocations (split days attribute correctly)", () => {
    const c = build([
      entry({
        userId: "u1",
        date: "2024-05-20",
        status: "approved",
        totalHours: 8,
        allocations: [
          { jobId: "j1", jobName: "100 Arthur", hours: 5 },
          { jobId: "j2", jobName: "Depot", hours: 3 },
        ],
      } as Partial<TimeEntry> & { userId: string; date: string }),
      entry({ userId: "u1", date: "2024-05-21", status: "submitted", totalHours: 7.6 }),
    ]);
    expect(c.approvedByJob).toEqual([
      { jobId: "j1", jobName: "100 Arthur", hours: 5 },
      { jobId: "j2", jobName: "Depot", hours: 3 },
    ]);
  });
});

describe("buildWeeklyHoursCloseout — readiness rules", () => {
  it("payroll-ready only when every day is approved or honestly not required", () => {
    const c = build([
      entry({ userId: "u1", date: "2024-05-20" }),
      entry({ userId: "u1", date: "2024-05-21" }),
    ]);
    expect(c.workers[0]!.readiness).toBe("payroll-ready");
    expect(c.summary.payrollReady).toBe(true);
    expect(c.summary.workersReady).toBe(1);
  });

  it("not ready while submitted entries remain (needs-review wins the label)", () => {
    const c = build([
      entry({ userId: "u1", date: "2024-05-20", status: "submitted" }),
      entry({ userId: "u1", date: "2024-05-21", status: "rejected" }),
    ]);
    expect(c.workers[0]!.readiness).toBe("needs-review");
    expect(c.summary.payrollReady).toBe(false);
  });

  it("not ready while rejected or draft entries remain (worker's move)", () => {
    const rejected = build([entry({ userId: "u1", date: "2024-05-20", status: "rejected" })]);
    expect(rejected.workers[0]!.readiness).toBe("needs-worker");

    const draft = build([entry({ userId: "u1", date: "2024-05-20", status: "draft" })]);
    expect(draft.workers[0]!.readiness).toBe("needs-worker");
    expect(draft.summary.draftDays).toBe(1);
  });

  it("not ready while server-flagged missing days remain", () => {
    const c = build(
      [entry({ userId: "u1", date: "2024-05-20" })],
      [missing("u1", "2024-05-22")],
    );
    expect(c.workers[0]!.readiness).toBe("missing-hours");
    expect(c.workers[0]!.missingCount).toBe(1);
    expect(c.workers[0]!.blockers).toContain("Wed missing");
    expect(c.summary.payrollReady).toBe(false);
  });

  it("a worker with ONLY missing days still appears (chase list), with zero approved", () => {
    const c = build([], [missing("u9", "2024-05-20", "Sam New")]);
    expect(c.workers).toHaveLength(1);
    expect(c.workers[0]!).toMatchObject({
      workerId: "u9",
      workerName: "Sam New",
      readiness: "missing-hours",
      approvedHours: 0,
    });
  });

  it("the week is payroll-ready only when ALL workers are ready", () => {
    const c = build([
      entry({ userId: "u1", date: "2024-05-20" }),
      entry({ userId: "u2", date: "2024-05-20", status: "submitted", userName: "Jack Smith" }),
    ]);
    expect(c.summary.payrollReady).toBe(false);
    expect(c.summary.workersReady).toBe(1);
    expect(c.summary.workersNeedAction).toBe(1);
  });

  it("an empty week is never payroll-ready (honest empty, not a green light)", () => {
    const c = build([]);
    expect(c.workers).toHaveLength(0);
    expect(c.summary.payrollReady).toBe(false);
  });
});

describe("buildWeeklyHoursCloseout — day statuses are honest", () => {
  it("future days are future, never missing", () => {
    // Today is Friday; no missing rows supplied for Sat/Sun or beyond.
    const c = build([entry({ userId: "u1", date: "2024-05-20" })], [], {
      todayISO: "2024-05-21", // Tuesday
    });
    const days = c.workers[0]!.days;
    expect(days[3]!.status).toBe("future"); // Thu
    expect(days[4]!.status).toBe("future"); // Fri
    expect(days.every((d) => d.status !== "missing")).toBe(true);
  });

  it("missing comes ONLY from the server's missing[] — no client-side guessing", () => {
    // Mon has no entry and is in the past, but the server didn't flag it
    // (e.g. the worker isn't in its tracked crew) → not-required, not missing.
    const c = build([entry({ userId: "u1", date: "2024-05-21" })]);
    expect(c.workers[0]!.days[0]!.status).toBe("not-required");
    expect(c.workers[0]!.missingCount).toBe(0);
  });

  it("weekends with no entry are not-required; a worked weekend shows its entry", () => {
    const c = build([entry({ userId: "u1", date: "2024-05-25", status: "approved" })]);
    const days = c.workers[0]!.days;
    expect(days[5]!.status).toBe("approved"); // Sat worked
    expect(days[6]!.status).toBe("not-required"); // Sun off
  });

  it("carries job label, hours, and the rejection reason onto the day", () => {
    const c = build([
      entry({
        userId: "u1",
        date: "2024-05-20",
        status: "rejected",
        rejectedReason: "Wrong job",
        totalHours: 7.6,
      }),
    ]);
    expect(c.workers[0]!.days[0]).toMatchObject({
      status: "rejected",
      jobLabel: "100 Arthur",
      hours: 7.6,
      rejectedReason: "Wrong job",
    });
  });

  it("labels split days by allocation count and null-job allocations honestly", () => {
    const c = build([
      entry({
        userId: "u1",
        date: "2024-05-20",
        allocations: [
          { jobId: "j1", jobName: "A", hours: 4 },
          { jobId: "j2", jobName: "B", hours: 3.6 },
        ],
      } as Partial<TimeEntry> & { userId: string; date: string }),
      entry({
        userId: "u1",
        date: "2024-05-21",
        allocations: [{ jobId: null, jobName: null, hours: 7.6 }],
      } as Partial<TimeEntry> & { userId: string; date: string }),
    ]);
    expect(c.workers[0]!.days[0]!.jobLabel).toBe("2 jobs");
    expect(c.workers[0]!.days[1]!.jobLabel).toBe("No job");
  });
});

describe("buildWeeklyHoursCloseout — ordering", () => {
  it("orders needing-action bands before ready, names within a band", () => {
    const c = build(
      [
        entry({ userId: "u_ready", date: "2024-05-20", userName: "Tom Brown" }),
        entry({
          userId: "u_review",
          date: "2024-05-20",
          status: "submitted",
          userName: "Jack Smith",
        }),
        entry({
          userId: "u_worker",
          date: "2024-05-20",
          status: "rejected",
          userName: "Oskar Ott",
        }),
      ],
      [missing("u_missing", "2024-05-20", "Sam New")],
    );
    expect(c.workers.map((w) => w.workerId)).toEqual([
      "u_review",
      "u_worker",
      "u_missing",
      "u_ready",
    ]);
  });
});

describe("labels", () => {
  it("maps readiness and day statuses to boss-facing words", () => {
    expect(readinessLabel("payroll-ready")).toBe("Ready");
    expect(readinessLabel("needs-review")).toBe("Needs review");
    expect(readinessLabel("needs-worker")).toBe("Waiting for worker");
    expect(readinessLabel("missing-hours")).toBe("Missing hours");
    expect(weeklyDayStatusLabel("draft")).toBe("Draft — not submitted");
    expect(weeklyDayStatusLabel("future")).toBe("—");
  });
});
