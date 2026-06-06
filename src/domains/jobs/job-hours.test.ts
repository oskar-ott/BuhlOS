import { describe, expect, it } from "vitest";
import {
  deriveJobHoursAttention,
  groupJobHoursByWorker,
  hoursOnJob,
  summariseJobHours,
} from "./job-hours";
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
      "job-1",
    );
    expect(s.hasAny).toBe(false);
    expect(s.totalHours).toBe(0);
  });

  it("buckets by status and totals the per-job slice across multi-job entries", () => {
    const s = summariseJobHours(
      [
        entry({ id: "a", userId: "u1", status: "submitted", allocations: [{ jobId: "job-1", hours: 6 }, { jobId: "job-9", hours: 2 }] } as Partial<TimeEntry>),
        entry({ id: "b", userId: "u2", userName: "Sam", status: "submitted", allocations: [{ jobId: "job-1", hours: 4 }] } as Partial<TimeEntry>),
        entry({ id: "c", userId: "u1", status: "approved", allocations: [{ jobId: "job-1", hours: 8 }] } as Partial<TimeEntry>),
        entry({ id: "d", userId: "u3", userName: "Lee", status: "rejected", allocations: [{ jobId: "job-1", hours: 5 }] } as Partial<TimeEntry>),
      ],
      "job-1",
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
        entry({ id: "d", date: "2026-12-31", allocations: [{ jobId: "job-2", hours: 8 }] } as Partial<TimeEntry>),
      ],
      "job-1",
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
      "job-1",
    );
    expect(s.totalHours).toBe(7.9);
  });
});

describe("groupJobHoursByWorker", () => {
  it("aggregates per worker and sorts by hours desc then name", () => {
    const rows = groupJobHoursByWorker(
      [
        entry({ id: "a", userId: "u1", userName: "Jack", allocations: [{ jobId: "job-1", hours: 4 }] } as Partial<TimeEntry>),
        entry({ id: "b", userId: "u1", userName: "Jack", allocations: [{ jobId: "job-1", hours: 4 }] } as Partial<TimeEntry>),
        entry({ id: "c", userId: "u2", userName: "Sam", allocations: [{ jobId: "job-1", hours: 8 }] } as Partial<TimeEntry>),
        entry({ id: "d", userId: "u3", userName: "Amy", allocations: [{ jobId: "job-1", hours: 8 }] } as Partial<TimeEntry>),
      ],
      "job-1",
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
        entry({ id: "a", userId: "u9", userName: "", allocations: [{ jobId: "job-1", hours: 3 }] } as Partial<TimeEntry>),
        entry({ id: "b", userId: "u8", allocations: [{ jobId: "job-2", hours: 9 }] } as Partial<TimeEntry>),
      ],
      "job-1",
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
