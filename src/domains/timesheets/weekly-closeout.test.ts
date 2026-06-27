import { describe, expect, it } from "vitest";
import type { MissingLog, TimeEntry } from "./types";
import {
  BULK_APPROVE_MAX,
  buildWeeklyHoursCloseout,
  readinessLabel,
  submittedWeekSelection,
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
  opts: {
    weekStart?: string;
    todayISO?: string;
    leave?: Array<{ date: string; userId: string; type: string }>;
  } = {},
) {
  return buildWeeklyHoursCloseout({
    entries,
    missing: missingLogs,
    weekStart: opts.weekStart ?? WEEK_START,
    todayISO: opts.todayISO ?? TODAY,
    leave: opts.leave,
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

  it("server-flagged missing rows for ANY tracked field role flow into readiness (#114)", () => {
    // The model is role-agnostic by design — whoever the server tracks counts.
    // Pre-#114 the server never emitted rows for electricians/apprentices; now
    // that it does, the week must go not-ready exactly the same way.
    const c = build(
      [entry({ userId: "u1", date: "2024-05-20" })],
      [
        { userId: "u_elec", date: "2024-05-21", userName: "Erin Sparks", role: "electrician" } as MissingLog,
        { userId: "u_appr", date: "2024-05-21", userName: "Alex First", role: "apprentice" } as MissingLog,
      ],
    );
    const elec = c.workers.find((w) => w.workerId === "u_elec")!;
    expect(elec).toMatchObject({ readiness: "missing-hours", workerRole: "electrician" });
    expect(c.summary.missingDays).toBe(2);
    expect(c.summary.payrollReady).toBe(false);
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

  it("carries the STORED ordinary/overtime split through to the day cell (#130)", () => {
    const c = build([
      entry({
        userId: "u1",
        date: "2024-05-20",
        totalHours: 10,
        ordinaryHours: 8,
        overtimeHours: 2,
        allocations: [{ jobId: "j1", jobName: "100 Arthur", hours: 10 }],
      } as Partial<TimeEntry> & { userId: string; date: string }),
    ]);
    const day = c.workers[0]!.days[0]!;
    expect(day.hours).toBe(10);
    expect(day.ordinaryHours).toBe(8);
    expect(day.overtimeHours).toBe(2);
    // Roll-up stays totalHours-based — the split is display-only, not double-counted.
    expect(c.workers[0]!.approvedHours).toBe(10);
  });

  it("a standard day has no overtime on its cell, and empty cells stay null (#130)", () => {
    const c = build(
      [entry({ userId: "u1", date: "2024-05-20", totalHours: 7.6, ordinaryHours: 7.6, overtimeHours: 0 })],
    );
    const days = c.workers[0]!.days;
    expect(days[0]!.overtimeHours).toBe(0);
    // Tue (no entry) — both split fields null, exactly like before.
    expect(days[1]!.hours).toBeNull();
    expect(days[1]!.ordinaryHours).toBeNull();
    expect(days[1]!.overtimeHours).toBeNull();
  });
});

describe("buildWeeklyHoursCloseout — approved leave (#333)", () => {
  it("a leave day reads as leave with its type — never missing", () => {
    const c = build(
      [entry({ userId: "u1", date: "2024-05-20" })],
      // The server would NOT flag a leave day as missing (it exempts it),
      // but even a stale missing row must lose to leave: leave is checked
      // first in the classification chain.
      [missing("u1", "2024-05-21")],
      { leave: [{ date: "2024-05-21", userId: "u1", type: "sick" }] },
    );
    const tue = c.workers[0]!.days[1]!;
    expect(tue.status).toBe("leave");
    expect(tue.leaveType).toBe("sick");
    expect(c.workers[0]!.missingCount).toBe(0);
    expect(c.workers[0]!.blockers).toEqual([]);
  });

  it("leave never blocks payroll readiness", () => {
    const c = build(
      [
        entry({ userId: "u1", date: "2024-05-20" }),
        entry({ userId: "u1", date: "2024-05-21" }),
        entry({ userId: "u1", date: "2024-05-22" }),
      ],
      [],
      {
        todayISO: "2024-05-24",
        leave: [
          { date: "2024-05-23", userId: "u1", type: "annual" },
          { date: "2024-05-24", userId: "u1", type: "annual" },
        ],
      },
    );
    expect(c.workers[0]!.readiness).toBe("payroll-ready");
  });

  it("hours logged on an approved-leave day raise the collision blocker", () => {
    const c = build(
      [entry({ userId: "u1", date: "2024-05-20", status: "approved" })],
      [],
      { leave: [{ date: "2024-05-20", userId: "u1", type: "rdo" }] },
    );
    const mon = c.workers[0]!.days[0]!;
    // The entry wins the cell (it's real work) but the office sees the flag.
    expect(mon.status).toBe("approved");
    expect(mon.leaveType).toBe("rdo");
    expect(c.workers[0]!.blockers).toContain("Mon logged while on leave");
  });

  it("another worker's leave never bleeds across rows", () => {
    const c = build(
      [
        entry({ userId: "u1", date: "2024-05-20" }),
        entry({ userId: "u2", date: "2024-05-20", userName: "Jack Smith" }),
      ],
      [],
      { leave: [{ date: "2024-05-21", userId: "u2", type: "annual" }] },
    );
    const u1 = c.workers.find((w) => w.workerId === "u1")!;
    const u2 = c.workers.find((w) => w.workerId === "u2")!;
    expect(u1.days[1]!.status).not.toBe("leave");
    expect(u2.days[1]!.status).toBe("leave");
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
    expect(weeklyDayStatusLabel("leave")).toBe("On leave");
  });
});

describe("submittedWeekSelection (#124 — the Approve-week payload)", () => {
  it("selects ONLY submitted days as {userId, date} pairs", () => {
    const closeout = buildWeeklyHoursCloseout({
      entries: [
        entry({ userId: "u1", date: "2024-05-20", status: "submitted" }),
        entry({ userId: "u1", date: "2024-05-21", status: "approved" }),
        entry({ userId: "u1", date: "2024-05-22", status: "rejected", rejectedReason: "x" }),
        entry({ userId: "u1", date: "2024-05-23", status: "draft" }),
        entry({ userId: "u1", date: "2024-05-24", status: "submitted" }),
      ],
      missing: [],
      weekStart: "2024-05-20",
      todayISO: "2024-05-24",
    });
    const worker = closeout.workers.find((w) => w.workerId === "u1")!;
    expect(submittedWeekSelection(worker)).toEqual([
      { userId: "u1", date: "2024-05-20" },
      { userId: "u1", date: "2024-05-24" },
    ]);
  });

  it("returns an empty selection when nothing is submitted (button has nothing to do)", () => {
    const closeout = buildWeeklyHoursCloseout({
      entries: [entry({ userId: "u1", date: "2024-05-20", status: "approved" })],
      missing: [],
      weekStart: "2024-05-20",
      todayISO: "2024-05-24",
    });
    const worker = closeout.workers.find((w) => w.workerId === "u1")!;
    expect(submittedWeekSelection(worker)).toEqual([]);
  });

  it("caps at the endpoint maximum", () => {
    expect(BULK_APPROVE_MAX).toBe(50);
    const days = Array.from({ length: 7 }, (_, i) => ({
      date: `2024-05-2${i % 7}`,
      weekday: "Mon",
      status: "submitted" as const,
      hours: 7.6,
      ordinaryHours: 7.6,
      overtimeHours: 0,
      entryId: `e${i}`,
      jobLabel: null,
      note: null,
      rejectedReason: null,
      exportId: null,
      leaveType: null,
    }));
    const worker = {
      workerId: "u1", workerName: "U", workerRole: null,
      readiness: "needs-review" as const,
      approvedHours: 0, approvedCount: 0, submittedCount: 7,
      rejectedCount: 0, draftCount: 0, missingCount: 0,
      blockers: [], days,
    };
    expect(submittedWeekSelection(worker).length).toBeLessThanOrEqual(BULK_APPROVE_MAX);
  });
});
