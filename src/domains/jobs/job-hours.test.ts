import { describe, expect, it } from "vitest";
import {
  costJobHours,
  deriveJobHoursAttention,
  groupJobHoursByWorker,
  hoursOnJob,
  listJobHoursRows,
  summariseJobHours,
} from "./job-hours";
import type { CostRateEntry } from "@/domains/cost-rates/schema";
import type { TimeEntry } from "@/domains/timesheets/types";

/**
 * The helper is fed the approver SUBMITTED queue in production, but it is
 * status-agnostic by design — these tests exercise the full multi-status
 * bucketing so the card can be upgraded to the full ledger later without
 * re-testing the maths.
 */
function entry(over: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: "te-1",
    userId: "u1",
    userName: "Jack",
    date: "2026-06-01",
    status: "submitted",
    totalHours: 8,
    allocations: [{ jobId: "job-1", hours: 8 }],
    ...over,
  } as unknown as TimeEntry;
}

describe("hoursOnJob", () => {
  it("sums only the allocations pointing at the job", () => {
    const e = entry({
      allocations: [
        { jobId: "job-1", hours: 5 },
        { jobId: "job-2", hours: 3 },
        { jobId: "job-1", hours: 2 },
      ],
    } as Partial<TimeEntry>);
    expect(hoursOnJob(e, "job-1")).toBe(7);
  });

  it("ignores null jobId, negative, and non-finite hours", () => {
    const e = entry({
      allocations: [
        { jobId: null, hours: 4 },
        { jobId: "job-1", hours: -2 },
        { jobId: "job-1", hours: Number.NaN },
        { jobId: "job-1", hours: 3 },
      ],
    } as unknown as Partial<TimeEntry>);
    expect(hoursOnJob(e, "job-1")).toBe(3);
  });

  it("is 0 for a missing jobId or malformed allocations", () => {
    expect(hoursOnJob(entry(), "")).toBe(0);
    expect(hoursOnJob({ allocations: undefined } as unknown as TimeEntry, "job-1")).toBe(0);
  });
});

describe("summariseJobHours", () => {
  it("returns an honest zeroed summary for no entries", () => {
    const s = summariseJobHours([], "job-1");
    expect(s.hasAny).toBe(false);
    expect(s.totalHours).toBe(0);
    expect(s.pendingCount).toBe(0);
    expect(s.workerCount).toBe(0);
    expect(s.latestDate).toBeNull();
  });

  it("ignores entries with no hours on this job", () => {
    const s = summariseJobHours(
      [entry({ allocations: [{ jobId: "job-2", hours: 8 }] } as Partial<TimeEntry>)],
      "job-1"
    );
    expect(s.hasAny).toBe(false);
    expect(s.totalHours).toBe(0);
  });

  it("buckets by status and totals the per-job slice across multi-job entries", () => {
    const s = summariseJobHours(
      [
        entry({
          id: "a",
          userId: "u1",
          status: "submitted",
          allocations: [
            { jobId: "job-1", hours: 6 },
            { jobId: "job-9", hours: 2 },
          ],
        } as Partial<TimeEntry>),
        entry({
          id: "b",
          userId: "u2",
          userName: "Sam",
          status: "submitted",
          allocations: [{ jobId: "job-1", hours: 4 }],
        } as Partial<TimeEntry>),
        entry({
          id: "c",
          userId: "u1",
          status: "approved",
          allocations: [{ jobId: "job-1", hours: 8 }],
        } as Partial<TimeEntry>),
        entry({
          id: "d",
          userId: "u3",
          userName: "Lee",
          status: "rejected",
          allocations: [{ jobId: "job-1", hours: 5 }],
        } as Partial<TimeEntry>),
      ],
      "job-1"
    );
    expect(s.hasAny).toBe(true);
    expect(s.pendingHours).toBe(10); // 6 + 4 (only the job-1 slice, not the +2 on job-9)
    expect(s.pendingCount).toBe(2);
    expect(s.approvedHours).toBe(8);
    expect(s.approvedCount).toBe(1);
    expect(s.rejectedHours).toBe(5);
    expect(s.rejectedCount).toBe(1);
    expect(s.totalHours).toBe(23);
    expect(s.workerCount).toBe(3); // u1, u2, u3 distinct
  });

  it("tracks the newest entry date among this job's entries", () => {
    const s = summariseJobHours(
      [
        entry({ id: "a", date: "2026-05-30" }),
        entry({ id: "b", date: "2026-06-04" }),
        entry({ id: "c", date: "2026-06-02" }),
        // other-job entry must not move the latest date
        entry({
          id: "d",
          date: "2026-12-31",
          allocations: [{ jobId: "job-2", hours: 8 }],
        } as Partial<TimeEntry>),
      ],
      "job-1"
    );
    expect(s.latestDate).toBe("2026-06-04");
  });

  it("rounds float summation noise to 2dp", () => {
    const s = summariseJobHours(
      [
        entry({ id: "a", allocations: [{ jobId: "job-1", hours: 7.6 }] } as Partial<TimeEntry>),
        entry({ id: "b", allocations: [{ jobId: "job-1", hours: 0.1 }] } as Partial<TimeEntry>),
        entry({ id: "c", allocations: [{ jobId: "job-1", hours: 0.2 }] } as Partial<TimeEntry>),
      ],
      "job-1"
    );
    expect(s.totalHours).toBe(7.9);
  });
});

describe("groupJobHoursByWorker", () => {
  it("aggregates per worker and sorts by hours desc then name", () => {
    const rows = groupJobHoursByWorker(
      [
        entry({
          id: "a",
          userId: "u1",
          userName: "Jack",
          allocations: [{ jobId: "job-1", hours: 4 }],
        } as Partial<TimeEntry>),
        entry({
          id: "b",
          userId: "u1",
          userName: "Jack",
          allocations: [{ jobId: "job-1", hours: 4 }],
        } as Partial<TimeEntry>),
        entry({
          id: "c",
          userId: "u2",
          userName: "Sam",
          allocations: [{ jobId: "job-1", hours: 8 }],
        } as Partial<TimeEntry>),
        entry({
          id: "d",
          userId: "u3",
          userName: "Amy",
          allocations: [{ jobId: "job-1", hours: 8 }],
        } as Partial<TimeEntry>),
      ],
      "job-1"
    );
    // All three tie at 8h (Jack via 4+4), so the tie-break is alphabetical.
    expect(rows.map((r) => [r.userName, r.hours, r.entryCount])).toEqual([
      ["Amy", 8, 1],
      ["Jack", 8, 2],
      ["Sam", 8, 1],
    ]);
  });

  it("falls back to userId when the name is missing and skips other jobs", () => {
    const rows = groupJobHoursByWorker(
      [
        entry({
          id: "a",
          userId: "u9",
          userName: "",
          allocations: [{ jobId: "job-1", hours: 3 }],
        } as Partial<TimeEntry>),
        entry({
          id: "b",
          userId: "u8",
          allocations: [{ jobId: "job-2", hours: 9 }],
        } as Partial<TimeEntry>),
      ],
      "job-1"
    );
    expect(rows).toEqual([{ userId: "u9", userName: "u9", hours: 3, entryCount: 1 }]);
  });
});

describe("deriveJobHoursAttention", () => {
  it("flags pending when hours await approval", () => {
    const s = summariseJobHours([entry({ status: "submitted" })], "job-1");
    expect(deriveJobHoursAttention(s)).toEqual({
      pending: true,
      pendingHours: 8,
      pendingCount: 1,
    });
  });

  it("is not pending when nothing is awaiting approval", () => {
    const s = summariseJobHours([entry({ status: "approved" })], "job-1");
    expect(deriveJobHoursAttention(s).pending).toBe(false);
  });
});

// ── Costing (owner pull 2026-08-23) — the Money card's maths, per worker ──

function rate(
  costRateCents: number,
  effectiveFrom = "2026-01-01",
  chargeOutRateCents: number | null = null
): CostRateEntry {
  return {
    id: `cr-${costRateCents}-${effectiveFrom}`,
    costRateCents,
    chargeOutRateCents,
    effectiveFrom,
    setBy: "u_admin",
    setByName: "boss",
    setAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("costJobHours", () => {
  it("costs approved and awaiting hours SEPARATELY at the rate effective on each day", () => {
    const c = costJobHours(
      [
        entry({
          id: "a",
          userId: "u1",
          userName: "Jack",
          date: "2026-06-01",
          status: "approved",
          allocations: [{ jobId: "job-1", hours: 8 }],
        }),
        entry({
          id: "b",
          userId: "u1",
          userName: "Jack",
          date: "2026-06-02",
          status: "submitted",
          allocations: [{ jobId: "job-1", hours: 4 }],
        }),
      ],
      "job-1",
      { u1: [rate(5000)] }
    );
    expect(c.ratesKnown).toBe(true);
    expect(c.approvedHours).toBe(8);
    expect(c.pendingHours).toBe(4);
    expect(c.approvedCostCents).toBe(40000); // 8h × $50 — equals the server's labourCostCents
    expect(c.pendingCostCents).toBe(20000); // never mixed into the approved figure
    expect(c.workers).toHaveLength(1);
    expect(c.workers[0]).toMatchObject({
      userId: "u1",
      rated: true,
      approvedCostCents: 40000,
      pendingCostCents: 20000,
      uncostedHours: 0,
    });
    expect(c.unratedWorkers).toEqual([]);
  });

  it("a rate that starts mid-job costs only the days it covers and flags the worker (partial, never a silent $0)", () => {
    const c = costJobHours(
      [
        entry({
          id: "a",
          userId: "u1",
          date: "2026-06-01",
          status: "approved",
          allocations: [{ jobId: "job-1", hours: 8 }],
        }),
        entry({
          id: "b",
          userId: "u1",
          date: "2026-06-10",
          status: "approved",
          allocations: [{ jobId: "job-1", hours: 8 }],
        }),
      ],
      "job-1",
      { u1: [rate(5000, "2026-06-05")] }
    );
    expect(c.approvedCostCents).toBe(40000); // only the 10 June day
    expect(c.workers[0]!.rated).toBe(false);
    expect(c.workers[0]!.uncostedHours).toBe(8);
    expect(c.unratedWorkers.map((w) => w.userId)).toEqual(["u1"]);
  });

  it("a worker with no history is unrated with a null cost; the rated worker is still costed", () => {
    const c = costJobHours(
      [
        entry({
          id: "a",
          userId: "u1",
          userName: "Jack",
          status: "approved",
          allocations: [{ jobId: "job-1", hours: 8 }],
        }),
        entry({
          id: "b",
          userId: "u2",
          userName: "Sam",
          status: "approved",
          allocations: [{ jobId: "job-1", hours: 2 }],
        }),
      ],
      "job-1",
      { u1: [rate(5000)] }
    );
    expect(c.approvedCostCents).toBe(40000);
    const sam = c.workers.find((w) => w.userId === "u2")!;
    expect(sam.approvedCostCents).toBeNull();
    expect(sam.rated).toBe(false);
    expect(c.unratedWorkers.map((w) => w.userName)).toEqual(["Sam"]);
  });

  it("with rates UNKNOWN (null) every cost is null, nobody is called unrated, hours still count", () => {
    const c = costJobHours([entry({ status: "approved" })], "job-1", null);
    expect(c.ratesKnown).toBe(false);
    expect(c.approvedHours).toBe(8);
    expect(c.approvedCostCents).toBeNull();
    expect(c.pendingCostCents).toBeNull();
    expect(c.unratedWorkers).toEqual([]);
    expect(c.workers[0]!.approvedCostCents).toBeNull();
  });

  it("ignores rejected/draft entries and other jobs; sorts heaviest contributor first", () => {
    const c = costJobHours(
      [
        entry({
          id: "a",
          userId: "u1",
          userName: "Zed",
          status: "approved",
          allocations: [{ jobId: "job-1", hours: 2 }],
        }),
        entry({
          id: "b",
          userId: "u2",
          userName: "Amy",
          status: "submitted",
          allocations: [{ jobId: "job-1", hours: 6 }],
        }),
        entry({
          id: "c",
          userId: "u3",
          userName: "Rej",
          status: "rejected",
          allocations: [{ jobId: "job-1", hours: 9 }],
        }),
        entry({
          id: "d",
          userId: "u4",
          userName: "Other",
          status: "approved",
          allocations: [{ jobId: "job-OTHER", hours: 9 }],
        }),
      ],
      "job-1",
      {}
    );
    expect(c.workers.map((w) => w.userName)).toEqual(["Amy", "Zed"]);
    expect(c.approvedHours).toBe(2);
    expect(c.pendingHours).toBe(6);
  });
});

describe("listJobHoursRows", () => {
  it("lists every approved/awaiting day on this job, newest first, with the worker and status", () => {
    const rows = listJobHoursRows(
      [
        entry({ id: "a", userId: "u1", userName: "Jack", date: "2026-06-01", status: "approved" }),
        entry({
          id: "b",
          userId: "u2",
          userName: "Sam",
          date: "2026-06-03",
          status: "submitted",
          allocations: [{ jobId: "job-1", hours: 7.6 }],
        }),
        entry({ id: "c", userId: "u3", userName: "Rej", date: "2026-06-04", status: "rejected" }),
        entry({
          id: "d",
          userId: "u1",
          userName: "Jack",
          date: "2026-06-03",
          status: "approved",
          allocations: [
            { jobId: "job-1", hours: 4 },
            { jobId: "job-OTHER", hours: 4 },
          ],
        }),
      ],
      "job-1"
    );
    expect(rows.map((r) => `${r.date} ${r.userName} ${r.hours} ${r.status}`)).toEqual([
      "2026-06-03 Jack 4 approved", // only this job's slice of the split day
      "2026-06-03 Sam 7.6 submitted",
      "2026-06-01 Jack 8 approved",
    ]);
  });
});
