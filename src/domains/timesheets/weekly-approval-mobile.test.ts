import { describe, expect, it } from "vitest";
import type { MissingLog, TimeEntry } from "./types";
import { buildWeeklyHoursCloseout } from "./weekly-closeout";
import {
  amendDayAllocations,
  buildQueryReason,
  canAmendDay,
  mobileBand,
  mobileSummary,
  partitionMobileWorkers,
  reviewQueueIds,
  submittedHoursOf,
  workerLongDayCount,
  workerOrdOtSplit,
} from "./weekly-approval-mobile";

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

const workerById = (c: ReturnType<typeof build>, id: string) =>
  c.workers.find((w) => w.workerId === id)!;

describe("mobileBand", () => {
  it("a submitted week is to-approve", () => {
    const c = build([entry({ userId: "u1", date: WEEK_START, status: "submitted" })]);
    expect(mobileBand(workerById(c, "u1"))).toBe("to-approve");
  });

  it("a fully approved week is approved", () => {
    const c = build([entry({ userId: "u1", date: WEEK_START, status: "approved" })]);
    expect(mobileBand(workerById(c, "u1"))).toBe("approved");
  });

  it("a rejected-only week is waiting (on the worker)", () => {
    const c = build([entry({ userId: "u1", date: WEEK_START, status: "rejected" })]);
    expect(mobileBand(workerById(c, "u1"))).toBe("waiting");
  });

  it("a server-flagged missing week is waiting", () => {
    // A worker who logged nothing but has a flagged missing weekday.
    const c = build([], [missing("u9", "2024-05-21")]);
    expect(mobileBand(workerById(c, "u9"))).toBe("waiting");
  });

  it("a submitted day alongside a rejected day still counts as to-approve", () => {
    const c = build([
      entry({ userId: "u1", date: "2024-05-20", status: "submitted" }),
      entry({ userId: "u1", date: "2024-05-21", status: "rejected" }),
    ]);
    expect(mobileBand(workerById(c, "u1"))).toBe("to-approve");
  });
});

describe("partitionMobileWorkers", () => {
  it("splits the run into the three bands, needs-action first", () => {
    const c = build(
      [
        entry({ userId: "u1", date: WEEK_START, status: "submitted" }),
        entry({ userId: "u2", date: WEEK_START, status: "approved" }),
        entry({ userId: "u3", date: WEEK_START, status: "rejected" }),
      ],
    );
    const bands = partitionMobileWorkers(c);
    expect(bands.toApprove.map((w) => w.workerId)).toEqual(["u1"]);
    expect(bands.approved.map((w) => w.workerId)).toEqual(["u2"]);
    expect(bands.waiting.map((w) => w.workerId)).toEqual(["u3"]);
  });

  it("an empty week yields three empty bands", () => {
    const bands = partitionMobileWorkers(build([]));
    expect(bands.toApprove).toHaveLength(0);
    expect(bands.approved).toHaveLength(0);
    expect(bands.waiting).toHaveLength(0);
  });
});

describe("workerOrdOtSplit", () => {
  it("no stored overtime → all ordinary, hasOvertime false", () => {
    const c = build([
      entry({ userId: "u1", date: "2024-05-20", totalHours: 8, ordinaryHours: 8, overtimeHours: 0 }),
      entry({ userId: "u1", date: "2024-05-21", totalHours: 8, ordinaryHours: 8, overtimeHours: 0 }),
    ]);
    const split = workerOrdOtSplit(workerById(c, "u1"));
    expect(split).toEqual({ ordinary: 16, overtime: 0, hasOvertime: false });
  });

  it("sums stored per-day overtime; ordinary is the remainder", () => {
    const c = build([
      entry({ userId: "u1", date: "2024-05-20", totalHours: 8, ordinaryHours: 8, overtimeHours: 0 }),
      entry({ userId: "u1", date: "2024-05-22", totalHours: 10.5, ordinaryHours: 8, overtimeHours: 2.5 }),
    ]);
    const split = workerOrdOtSplit(workerById(c, "u1"));
    expect(split.overtime).toBe(2.5);
    expect(split.ordinary).toBe(16); // 18.5 logged − 2.5 OT
    expect(split.hasOvertime).toBe(true);
  });

  it("ordinary never goes negative on odd data", () => {
    // overtimeHours exceeding the day total (garbage) can't push ordinary < 0.
    const c = build([
      entry({ userId: "u1", date: "2024-05-20", totalHours: 8, ordinaryHours: 0, overtimeHours: 20 }),
    ]);
    const split = workerOrdOtSplit(workerById(c, "u1"));
    expect(split.ordinary).toBeGreaterThanOrEqual(0);
  });
});

describe("submittedHoursOf", () => {
  it("sums ONLY submitted days — not already-approved ones in a mixed week", () => {
    const c = build([
      entry({ userId: "u1", date: "2024-05-20", status: "approved", totalHours: 8 }),
      entry({ userId: "u1", date: "2024-05-21", status: "approved", totalHours: 8 }),
      entry({ userId: "u1", date: "2024-05-22", status: "submitted", totalHours: 8 }),
      entry({ userId: "u1", date: "2024-05-23", status: "submitted", totalHours: 8.5 }),
    ]);
    const w = workerById(c, "u1");
    expect(w.loggedHours).toBe(32.5); // whole week
    expect(submittedHoursOf(w)).toBe(16.5); // only the two submitted days
  });

  it("is 0 when nothing is submitted", () => {
    const c = build([entry({ userId: "u1", date: "2024-05-20", status: "approved", totalHours: 8 })]);
    expect(submittedHoursOf(workerById(c, "u1"))).toBe(0);
  });
});

describe("workerLongDayCount", () => {
  it("counts stored-OT days and >10h days", () => {
    const c = build([
      entry({ userId: "u1", date: "2024-05-20", totalHours: 8, overtimeHours: 0 }),
      entry({ userId: "u1", date: "2024-05-21", totalHours: 10.5, ordinaryHours: 8, overtimeHours: 2.5 }),
      entry({ userId: "u1", date: "2024-05-22", totalHours: 11, ordinaryHours: 11, overtimeHours: 0 }),
    ]);
    expect(workerLongDayCount(workerById(c, "u1"))).toBe(2);
  });
});

describe("mobileSummary", () => {
  it("reports band counts, logged + overtime totals, and progress", () => {
    const c = build([
      // u1: approved clean week (ready)
      entry({ userId: "u1", date: "2024-05-20", status: "approved", totalHours: 8, overtimeHours: 0 }),
      // u2: submitted with 2.5h stored OT (to approve)
      entry({ userId: "u2", date: "2024-05-20", status: "submitted", totalHours: 10.5, ordinaryHours: 8, overtimeHours: 2.5 }),
      // u3: rejected (waiting)
      entry({ userId: "u3", date: "2024-05-20", status: "rejected", totalHours: 8, overtimeHours: 0 }),
    ]);
    const s = mobileSummary(c);
    expect(s.crewCount).toBe(3);
    expect(s.readyCount).toBe(1);
    expect(s.toApproveCount).toBe(1);
    expect(s.waitingCount).toBe(1);
    expect(s.overtimeShort).toBe("2.5");
    expect(s.hasOvertime).toBe(true);
    expect(s.loggedHoursShort).toBe("26.5"); // 8 + 10.5 + 8
    expect(s.progressPct).toBe(33); // 1 of 3 ready
    expect(s.allReady).toBe(false);
  });

  it("an all-approved run reads allReady with 0 overtime", () => {
    const c = build([
      entry({ userId: "u1", date: "2024-05-20", status: "approved", totalHours: 8, overtimeHours: 0 }),
    ]);
    const s = mobileSummary(c);
    expect(s.allReady).toBe(true);
    expect(s.hasOvertime).toBe(false);
    expect(s.overtimeShort).toBe("0");
  });
});

describe("reviewQueueIds", () => {
  it("is exactly the to-approve band, in order", () => {
    const c = build([
      entry({ userId: "u1", date: WEEK_START, status: "submitted" }),
      entry({ userId: "u2", date: WEEK_START, status: "approved" }),
      entry({ userId: "u3", date: WEEK_START, status: "submitted" }),
    ]);
    expect(reviewQueueIds(c)).toEqual(["u1", "u3"]);
  });
});

describe("buildQueryReason", () => {
  it("a chip alone is its own reason", () => {
    expect(buildQueryReason("Wrong job")).toBe("Wrong job");
  });

  it("a chip plus a note appends the note", () => {
    expect(buildQueryReason("Hours look high", "Thu looks like a double-up")).toBe(
      "Hours look high — Thu looks like a double-up",
    );
  });

  it("'Other' carries the note as the whole reason", () => {
    expect(buildQueryReason("Other", "Booked to the wrong site")).toBe(
      "Booked to the wrong site",
    );
  });

  it("'Other' with no note is null (keeps the send button disabled)", () => {
    expect(buildQueryReason("Other")).toBeNull();
    expect(buildQueryReason("Other", "   ")).toBeNull();
  });
});

/**
 * "Fix the hours and approve" on the phone (owner-directed). The RULES live
 * here — the sheet is client-only, so the projection is where they can be
 * pinned honestly.
 */
describe("canAmendDay — what the office may fix in the day review", () => {
  function dayOf(status: TimeEntry["status"], date = "2024-05-20") {
    const c = build([entry({ userId: "u1", date, status, totalHours: 8.37 })]);
    return c.workers[0]!.days.find((d) => d.date === date)!;
  }

  it("offers the fix only on a day still waiting on a decision", () => {
    expect(canAmendDay(dayOf("submitted"), true)).toBe(true);
    // Approved is reopened, not silently rewritten; rejected/draft are the
    // worker's to fix. Same rule the server enforces (409 otherwise).
    expect(canAmendDay(dayOf("approved"), true)).toBe(false);
    expect(canAmendDay(dayOf("rejected"), true)).toBe(false);
    expect(canAmendDay(dayOf("draft"), true)).toBe(false);
  });

  it("never offers it to a leading hand — changing pay is the office's call", () => {
    expect(canAmendDay(dayOf("submitted"), false)).toBe(false);
  });

  it("never offers it on a day with nothing logged", () => {
    const c = build([], [missing("u1", "2024-05-22")]);
    const wed = c.workers[0]!.days.find((d) => d.date === "2024-05-22")!;
    expect(wed.status).toBe("missing");
    expect(canAmendDay(wed, true)).toBe(false);
  });
});

describe("amendDayAllocations — each job's own time, never an invented split", () => {
  it("carries the day's REAL allocations, named", () => {
    const c = build([
      entry({
        userId: "u1",
        date: "2024-05-20",
        status: "submitted",
        totalHours: 8,
        allocations: [
          { jobId: "j1", jobName: "UTS Building 11", hours: 5 },
          { jobId: "j2", jobName: "Depot", hours: 3 },
        ],
      } as Partial<TimeEntry> & { userId: string; date: string }),
    ]);
    const mon = c.workers[0]!.days.find((d) => d.date === "2024-05-20")!;
    expect(amendDayAllocations(mon)).toEqual([
      { jobId: "j1", label: "UTS Building 11", hours: 5 },
      { jobId: "j2", label: "Depot", hours: 3 },
    ]);
  });

  it("an unattributed day is ONE no-job row — exactly what the entry is", () => {
    const c = build([
      entry({
        userId: "u1",
        date: "2024-05-20",
        status: "submitted",
        totalHours: 7.6,
        allocations: [{ jobId: null, hours: 7.6 }],
      } as Partial<TimeEntry> & { userId: string; date: string }),
    ]);
    const mon = c.workers[0]!.days.find((d) => d.date === "2024-05-20")!;
    expect(amendDayAllocations(mon)).toEqual([{ jobId: null, label: "No job", hours: 7.6 }]);
  });
});
