import { describe, expect, it } from "vitest";
import type { MissingLog, TimeEntry } from "./types";
import { buildWeeklyHoursCloseout } from "./weekly-closeout";
import {
  CLOSEOUT_DEFAULT_REJECT_REASON,
  closeoutRejectReason,
  reviewDayRows,
  weeklyReviewQueue,
  workerStatusWord,
} from "./weekly-review";

/**
 * Unit tests for the DESKTOP closeout-wizard helpers added to weekly-review.ts
 * (lean-reset redesign). The pre-existing shared pieces (bands, ord/OT split,
 * queue, query reasons) stay covered by weekly-approval-mobile.test.ts, which
 * now exercises the re-export shim as a bonus.
 */

// Pinned week: Monday 2024-05-20 … Sunday 2024-05-26; today = Friday 2024-05-24.
const WEEK_START = "2024-05-20";
const TODAY = "2024-05-24";

function entry(p: Partial<TimeEntry> & { userId: string; date: string }): TimeEntry {
  return {
    id: `te_${p.userId}_${p.date}`,
    userName:
      p.userId === "u1" ? "Ari Boland" : p.userId === "u2" ? "Rhys Kelly" : "Sam Pryce",
    userRole: "Electrician",
    totalHours: 8,
    ordinaryHours: 8,
    overtimeHours: 0,
    status: "submitted",
    rejectedReason: null,
    notes: null,
    allocations: [{ jobId: "j1", jobName: "UTS Building 11", hours: p.totalHours ?? 8 }],
    ...p,
  } as unknown as TimeEntry;
}

function missing(userId: string, date: string, userName = "Josh Mason"): MissingLog {
  return { userId, date, userName, role: "Leading hand" } as MissingLog;
}

function build(entries: TimeEntry[], missingLogs: MissingLog[] = []) {
  return buildWeeklyHoursCloseout({
    entries,
    missing: missingLogs,
    weekStart: WEEK_START,
    todayISO: TODAY,
  });
}

const workerById = (c: ReturnType<typeof build>, id: string) =>
  c.workers.find((w) => w.workerId === id)!;

describe("weeklyReviewQueue", () => {
  it("walks the WHOLE crew in model order — needs-review first, ready last", () => {
    const c = build(
      [
        entry({ userId: "u1", date: WEEK_START, status: "approved" }), // ready
        entry({ userId: "u2", date: WEEK_START, status: "submitted" }), // needs review
      ],
      [missing("u3", "2024-05-21")], // missing-hours — still in the walk
    );
    expect(weeklyReviewQueue(c)).toEqual(["u2", "u3", "u1"]);
  });

  it("is empty for an empty week — never a fabricated stop", () => {
    expect(weeklyReviewQueue(build([]))).toEqual([]);
  });
});

describe("workerStatusWord", () => {
  it("names submitted days to approve, with a correct singular", () => {
    const one = build([entry({ userId: "u1", date: WEEK_START })]);
    expect(workerStatusWord(workerById(one, "u1"))).toBe("1 day to approve");
    const two = build([
      entry({ userId: "u1", date: "2024-05-20" }),
      entry({ userId: "u1", date: "2024-05-21" }),
    ]);
    expect(workerStatusWord(workerById(two, "u1"))).toBe("2 days to approve");
  });

  it("puts sent-back first, even when other days are still submitted", () => {
    const c = build([
      entry({ userId: "u1", date: "2024-05-20", status: "rejected", rejectedReason: "x" }),
      entry({ userId: "u1", date: "2024-05-21", status: "submitted" }),
    ]);
    expect(workerStatusWord(workerById(c, "u1"))).toBe("A day was sent back");
  });

  it("says 'No hours logged this week' for a missing-only week", () => {
    const c = build([], [missing("u3", "2024-05-21")]);
    expect(workerStatusWord(workerById(c, "u3"))).toBe("No hours logged this week");
  });

  it("says 'Already approved' only for a settled week", () => {
    const c = build([entry({ userId: "u1", date: WEEK_START, status: "approved" })]);
    expect(workerStatusWord(workerById(c, "u1"))).toBe("Already approved");
  });

  it("flags a lingering draft", () => {
    const c = build([entry({ userId: "u1", date: WEEK_START, status: "draft" })]);
    expect(workerStatusWord(workerById(c, "u1"))).toBe("A day is still a draft");
  });
});

describe("closeoutRejectReason", () => {
  it("prefers the boss's trimmed note", () => {
    expect(closeoutRejectReason("  Wrong job — split it 6/4  ")).toBe(
      "Wrong job — split it 6/4",
    );
  });

  it("falls back to the default when the note is empty (the API 400s on '')", () => {
    expect(closeoutRejectReason("")).toBe(CLOSEOUT_DEFAULT_REJECT_REASON);
    expect(closeoutRejectReason("   ")).toBe(CLOSEOUT_DEFAULT_REJECT_REASON);
    expect(closeoutRejectReason(undefined)).toBe(CLOSEOUT_DEFAULT_REJECT_REASON);
    expect(CLOSEOUT_DEFAULT_REJECT_REASON.length).toBeGreaterThan(0);
  });
});

describe("reviewDayRows", () => {
  it("keeps every weekday, drops empty weekends, keeps a worked weekend", () => {
    const c = build([
      entry({ userId: "u1", date: "2024-05-20" }),
      entry({ userId: "u1", date: "2024-05-25", totalHours: 4 }), // Saturday worked
    ]);
    const rows = reviewDayRows(workerById(c, "u1"));
    expect(rows.map((r) => r.day.weekday)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
  });

  it("notes unlogged days honestly — Missing / Not on / Not yet — never a 0", () => {
    const c = build(
      [entry({ userId: "u1", date: "2024-05-20" })],
      [missing("u1", "2024-05-21", "Ari Boland")],
    );
    const rows = reviewDayRows(workerById(c, "u1"));
    const byDay = Object.fromEntries(rows.map((r) => [r.day.weekday, r.note]));
    expect(byDay["Mon"]).toBeNull(); // logged — the row shows the real jobs
    expect(byDay["Tue"]).toBe("Missing"); // server-flagged
    expect(byDay["Wed"]).toBe("Not on"); // past weekday the server doesn't track
    expect(byDay["Fri"]).toBe("Not on"); // today (not yet future)
  });

  it("labels a future weekday 'Not yet'", () => {
    const c = buildWeeklyHoursCloseout({
      entries: [entry({ userId: "u1", date: "2024-05-20" })],
      missing: [],
      weekStart: WEEK_START,
      todayISO: "2024-05-21", // Tuesday — Wed–Fri are future
    });
    const rows = reviewDayRows(workerById(c, "u1"));
    const byDay = Object.fromEntries(rows.map((r) => [r.day.weekday, r.note]));
    expect(byDay["Wed"]).toBe("Not yet");
  });
});
