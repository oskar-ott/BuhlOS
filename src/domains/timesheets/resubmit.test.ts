import { describe, expect, it } from "vitest";
import {
  buildResubmitPayload,
  buildSplitResubmitPayload,
  canResubmitInPhil,
  isSplitResubmit,
  resolveResubmitJob,
  resubmitFeedback,
  resubmitInitialJobId,
  splitResubmitInitialRows,
} from "./resubmit";
import type { TimeEntry } from "./types";

function te(over: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: "te-1",
    userId: "u1",
    date: "2026-06-03",
    totalHours: 7.6,
    ordinaryHours: 7.6,
    overtimeHours: 0,
    status: "rejected",
    rejectedReason: "Wrong job",
    allocations: [{ jobId: "job-a", hours: 7.6, notes: null }],
    createdAt: "2026-06-03T08:00:00Z",
    updatedAt: "2026-06-03T08:00:00Z",
    ...over,
  } as unknown as TimeEntry;
}

const JOBS = [
  { id: "job-a", name: "Smith St" },
  { id: "job-b", name: "Jones Rd" },
];

describe("canResubmitInPhil", () => {
  it("allows a rejected single-allocation entry", () => {
    expect(canResubmitInPhil(te({ status: "rejected" }))).toBe(true);
  });
  it("ALLOWS a submitted (undecided) entry — 2026-07-26 owner-directed: the worker can fix a sent day until the office decides", () => {
    expect(canResubmitInPhil(te({ status: "submitted" }))).toBe(true);
    expect(canResubmitInPhil(te({ status: "submitted", allocations: [] }))).toBe(false);
  });
  it("rejects approved (locked) and draft (its own send flow) statuses", () => {
    expect(canResubmitInPhil(te({ status: "approved" }))).toBe(false);
    expect(canResubmitInPhil(te({ status: "draft" }))).toBe(false);
  });
  it("ALLOWS a rejected multi-allocation (split) entry — routed to the split editor", () => {
    const multi = te({
      allocations: [
        { jobId: "job-a", hours: 4, notes: null },
        { jobId: "job-b", hours: 3.6, notes: null },
      ],
    });
    expect(canResubmitInPhil(multi)).toBe(true);
  });
  it("rejects an entry with no allocations", () => {
    expect(canResubmitInPhil(te({ allocations: [] }))).toBe(false);
  });
});

describe("isSplitResubmit", () => {
  it("is true for 2+ allocations, false for a single allocation", () => {
    expect(isSplitResubmit(te())).toBe(false);
    expect(
      isSplitResubmit(
        te({
          allocations: [
            { jobId: "job-a", hours: 4, notes: null },
            { jobId: "job-b", hours: 3.6, notes: null },
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe("splitResubmitInitialRows", () => {
  const split = te({
    totalHours: 7.6,
    allocations: [
      { jobId: "job-a", hours: 4, notes: null },
      { jobId: "job-b", hours: 3.6, notes: null },
    ],
  });
  it("seeds the total and one row per allocation, preserving still-assigned jobs", () => {
    expect(splitResubmitInitialRows(split, JOBS)).toEqual({
      total: 7.6,
      rows: [
        { jobId: "job-a", hours: 4 },
        { jobId: "job-b", hours: 3.6 },
      ],
    });
  });
  it("nulls a row whose job is no longer assigned (forces a re-pick, no stale attribution)", () => {
    const stale = te({
      totalHours: 7.6,
      allocations: [
        { jobId: "job-a", hours: 4, notes: null },
        { jobId: "job-z", hours: 3.6, notes: null }, // job-z not in JOBS
      ],
    });
    expect(splitResubmitInitialRows(stale, JOBS).rows).toEqual([
      { jobId: "job-a", hours: 4 },
      { jobId: null, hours: 3.6 },
    ]);
  });
});

describe("buildSplitResubmitPayload", () => {
  it("PRESERVES every allocation, submits, and OT-splits on the day total", () => {
    const payload = buildSplitResubmitPayload(te(), {
      totalHours: 10,
      allocations: [
        { jobId: "job-a", hours: 6 },
        { jobId: "job-b", hours: 4 },
      ],
      notes: "kept",
    });
    expect(payload.status).toBe("submitted");
    expect(payload.date).toBe("2026-06-03");
    expect(payload.notes).toBe("kept");
    expect(payload.allocations).toEqual([
      { jobId: "job-a", hours: 6, notes: null },
      { jobId: "job-b", hours: 4, notes: null },
    ]);
    // OT split on the TOTAL (day property), allocations sum to total.
    expect(payload.ordinaryHours).toBe(8);
    expect(payload.overtimeHours).toBe(2);
    expect(payload.allocations.reduce((s, a) => s + a.hours, 0)).toBeCloseTo(payload.totalHours, 5);
  });
});

describe("resubmitInitialJobId", () => {
  it("preserves the original job when still assigned", () => {
    expect(resubmitInitialJobId(te({ allocations: [{ jobId: "job-b", hours: 7.6, notes: null }] }), JOBS)).toBe(
      "job-b",
    );
  });
  it("auto-selects the sole assigned job when the original is null", () => {
    const nullJob = te({ allocations: [{ jobId: null, hours: 7.6, notes: null }] });
    expect(resubmitInitialJobId(nullJob, [JOBS[0]!])).toBe("job-a");
  });
  it("requires an explicit pick (null) when the original is null and multiple jobs exist", () => {
    const nullJob = te({ allocations: [{ jobId: null, hours: 7.6, notes: null }] });
    expect(resubmitInitialJobId(nullJob, JOBS)).toBeNull();
  });
  it("does not preserve an original job the worker is no longer assigned to", () => {
    const stale = te({ allocations: [{ jobId: "job-z", hours: 7.6, notes: null }] });
    expect(resubmitInitialJobId(stale, JOBS)).toBeNull(); // multiple → must pick
    expect(resubmitInitialJobId(stale, [JOBS[0]!])).toBe("job-a"); // sole → auto
  });
});

describe("resolveResubmitJob", () => {
  it("blocks when jobs failed to load (never falls back to null)", () => {
    expect(resolveResubmitJob({ assignedJobs: JOBS, selectedJobId: "job-a", jobsError: true })).toEqual({
      ok: false,
      reason: "jobs_error",
    });
  });
  it("blocks when there are no active assigned jobs", () => {
    expect(resolveResubmitJob({ assignedJobs: [], selectedJobId: null, jobsError: false })).toEqual({
      ok: false,
      reason: "no_jobs",
    });
  });
  it("blocks when multiple jobs exist and none is selected", () => {
    expect(resolveResubmitJob({ assignedJobs: JOBS, selectedJobId: null, jobsError: false })).toEqual({
      ok: false,
      reason: "no_selection",
    });
  });
  it("blocks when the selection is not an assigned job", () => {
    expect(resolveResubmitJob({ assignedJobs: JOBS, selectedJobId: "job-z", jobsError: false })).toEqual({
      ok: false,
      reason: "no_selection",
    });
  });
  it("resolves to the selected job when valid", () => {
    expect(resolveResubmitJob({ assignedJobs: JOBS, selectedJobId: "job-b", jobsError: false })).toEqual({
      ok: true,
      jobId: "job-b",
    });
  });
});

describe("buildResubmitPayload", () => {
  it("preserves the entry date, submits, and attributes to the resolved job", () => {
    const payload = buildResubmitPayload(te(), { totalHours: 7.6, jobId: "job-a", notes: "fixed" });
    expect(payload.date).toBe("2026-06-03");
    expect(payload.status).toBe("submitted");
    expect(payload.notes).toBe("fixed");
    expect(payload.allocations).toEqual([{ jobId: "job-a", hours: 7.6, notes: null }]);
  });
  it("never emits a null jobId and the allocation sums to total", () => {
    const payload = buildResubmitPayload(te(), { totalHours: 9, jobId: "job-b", notes: null });
    expect(payload.allocations[0]!.jobId).toBe("job-b");
    expect(payload.allocations[0]!.jobId).not.toBeNull();
    expect(payload.allocations.reduce((s, a) => s + a.hours, 0)).toBeCloseTo(payload.totalHours, 5);
  });
  it("splits ordinary/overtime at 8h like the server", () => {
    const payload = buildResubmitPayload(te(), { totalHours: 10, jobId: "job-a", notes: null });
    expect(payload.ordinaryHours).toBe(8);
    expect(payload.overtimeHours).toBe(2);
    expect(payload.ordinaryHours + payload.overtimeHours).toBeCloseTo(payload.totalHours, 5);
  });
});

describe("resubmitFeedback", () => {
  it("maps a successful PATCH to the resubmitted entry", () => {
    const entry = te({ status: "submitted", rejectedReason: null });
    const fb = resubmitFeedback({ ok: true, data: { entry } });
    expect(fb).toEqual({ kind: "success", entry });
  });
  it("maps 401 / 403 / 404 to honest, specific messages", () => {
    const f401 = resubmitFeedback({ ok: false, error: { status: 401, message: "x", body: null } });
    const f403 = resubmitFeedback({ ok: false, error: { status: 403, message: "x", body: null } });
    const f404 = resubmitFeedback({ ok: false, error: { status: 404, message: "x", body: null } });
    expect(f401).toMatchObject({ kind: "error", status: 401 });
    expect(f403.kind === "error" && /reopen/i.test(f403.message)).toBe(true);
    expect(f404.kind === "error" && /refresh/i.test(f404.message)).toBe(true);
  });
  it("falls back to the server message for other errors", () => {
    const fb = resubmitFeedback({
      ok: false,
      error: { status: 400, message: "Allocation hours must sum", body: null },
    });
    expect(fb).toEqual({ kind: "error", status: 400, message: "Allocation hours must sum" });
  });
});
