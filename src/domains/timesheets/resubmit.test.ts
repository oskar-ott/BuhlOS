import { describe, expect, it } from "vitest";
import {
  buildDayTypeResubmitPayload,
  buildResubmitPayload,
  buildSplitResubmitPayload,
  canResubmitInPhil,
  fixDayTypeOptions,
  initialFixDayType,
  officeDayTypeOptions,
  isSplitResubmit,
  resolveResubmitJob,
  resubmitFeedback,
  resubmitInitialJobId,
  splitChangeInitialRows,
  splitResubmitInitialRows,
} from "./resubmit";
import { CreateTimeEntryPayloadSchema, PatchTimeEntryPayloadSchema } from "./schema";
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
  it("ALLOWS day-type days (owner pull 2026-10-11) — the sheet opens ON the day type, never forcing a job onto it", () => {
    const leave = { allocations: [{ jobId: null, hours: 7.6, notes: null }] };
    expect(canResubmitInPhil(te({ status: "rejected", dayType: "tafe", ...leave }))).toBe(true);
    expect(canResubmitInPhil(te({ status: "submitted", dayType: "sick", ...leave }))).toBe(true);
    expect(canResubmitInPhil(te({ status: "submitted", dayType: "holiday", ...leave }))).toBe(true);
    // Approved stays locked for pay whatever the day is.
    expect(canResubmitInPhil(te({ status: "approved", dayType: "holiday", ...leave }))).toBe(false);
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

// 2026-07-26 owner-directed: split a SINGLE-allocation day across jobs from
// inside the change/fix flow — the split editor is seeded from the entry.
describe("splitChangeInitialRows", () => {
  it("seeds row 1 with the current job carrying the day's hours, plus an empty remainder row", () => {
    expect(splitChangeInitialRows(te(), JOBS)).toEqual({
      total: 7.6,
      rows: [
        { jobId: "job-a", hours: 7.6 },
        { jobId: null, hours: 0 },
      ],
    });
  });
  it("seeds null when the current job is no longer assigned (forces a re-pick, no stale attribution)", () => {
    const stale = te({ allocations: [{ jobId: "job-z", hours: 7.6, notes: null }] });
    expect(splitChangeInitialRows(stale, JOBS).rows[0]).toEqual({ jobId: null, hours: 7.6 });
  });
  it("always seeds TWO rows — SplitDaySheet only honours initialRows with 2+ rows", () => {
    expect(splitChangeInitialRows(te(), JOBS).rows).toHaveLength(2);
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
    // Boundary = the standard day (7.6h), owner-directed 2026-08-09.
    expect(payload.ordinaryHours).toBe(7.6);
    expect(payload.overtimeHours).toBe(2.4);
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
  it("splits ordinary/overtime at the standard day (7.6h) like the server", () => {
    const payload = buildResubmitPayload(te(), { totalHours: 10, jobId: "job-a", notes: null });
    expect(payload.ordinaryHours).toBe(7.6);
    expect(payload.overtimeHours).toBe(2.4);
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

/**
 * Owner pull 2026-10-11: "I can't change days to a sick day or holiday if I
 * log it on a job by mistake" — four of the crew (the owner included) logged
 * the 5 Oct public holiday as a normal job day, and nothing could turn it
 * into a holiday. The change sheet now can, and back.
 */
describe("day types on the change sheet", () => {
  it("a job day logged by mistake becomes a holiday: no job, all ordinary, still submitted", () => {
    const payload = buildDayTypeResubmitPayload(te({ date: "2026-10-05", status: "submitted" }), {
      totalHours: 7.6,
      dayType: "holiday",
      notes: null,
    });
    expect(payload).toEqual({
      date: "2026-10-05",
      totalHours: 7.6,
      ordinaryHours: 7.6,
      overtimeHours: 0,
      allocations: [{ jobId: null, hours: 7.6, notes: null }],
      status: "submitted",
      notes: null,
      dayType: "holiday",
    });
    expect(PatchTimeEntryPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("leave never splits into overtime — a long sick day or a weekend one books all ordinary", () => {
    const long = buildDayTypeResubmitPayload(te(), { totalHours: 9.6, dayType: "sick", notes: null });
    expect(long).toMatchObject({ ordinaryHours: 9.6, overtimeHours: 0 });
    const saturday = buildDayTypeResubmitPayload(te({ date: "2026-10-10" }), {
      totalHours: 7.6,
      dayType: "sick",
      notes: null,
    });
    expect(saturday).toMatchObject({ ordinaryHours: 7.6, overtimeHours: 0 });
  });

  it("a holiday switched back to a job day CLEARS the type (the server keeps it unless told)", () => {
    const holiday = te({
      status: "submitted",
      dayType: "holiday",
      allocations: [{ jobId: null, hours: 7.6, notes: null }],
    });
    const back = buildResubmitPayload(holiday, { totalHours: 7.6, jobId: "job-a", notes: null });
    expect(back.dayType).toBeNull();
    expect(back.allocations).toEqual([{ jobId: "job-a", hours: 7.6, notes: null }]);
    expect(PatchTimeEntryPayloadSchema.safeParse(back).success).toBe(true);
    const split = buildSplitResubmitPayload(holiday, {
      totalHours: 7.6,
      allocations: [
        { jobId: "job-a", hours: 4 },
        { jobId: "job-b", hours: 3.6 },
      ],
      notes: null,
    });
    expect(split.dayType).toBeNull();
  });

  it("a plain job day's payload is unchanged — no dayType key at all", () => {
    const payload = buildResubmitPayload(te(), { totalHours: 7.6, jobId: "job-a", notes: null });
    expect("dayType" in payload).toBe(false);
  });

  it("only an EDIT may clear a day type; a create still can't send null", () => {
    const base = {
      date: "2026-10-05",
      totalHours: 7.6,
      ordinaryHours: 7.6,
      overtimeHours: 0,
      allocations: [{ jobId: "job-a", hours: 7.6, notes: null }],
      dayType: null,
    };
    expect(PatchTimeEntryPayloadSchema.safeParse(base).success).toBe(true);
    expect(CreateTimeEntryPayloadSchema.safeParse(base).success).toBe(false);
  });

  it("offers sick / holiday to everyone, TAFE to apprentices — and always the day's own type", () => {
    expect(fixDayTypeOptions(false, null)).toEqual(["sick", "holiday"]);
    expect(fixDayTypeOptions(true, null)).toEqual(["sick", "holiday", "tafe"]);
    expect(fixDayTypeOptions(false, "tafe")).toEqual(["sick", "holiday", "tafe"]);
  });

  it("the sheet starts on the entry's own type (null for a job day)", () => {
    expect(initialFixDayType(te())).toBeNull();
    expect(initialFixDayType(te({ dayType: "holiday" }))).toBe("holiday");
    expect(initialFixDayType(te({ dayType: "sick" }))).toBe("sick");
    expect(initialFixDayType(te({ dayType: "tafe" }))).toBe("tafe");
  });
});

describe("officeDayTypeOptions — what the office's fix may switch a day to", () => {
  it("sick / holiday for anyone; TAFE for an apprentice (any casing) or a day that already is one", () => {
    expect(officeDayTypeOptions("electrician", null)).toEqual(["sick", "holiday"]);
    expect(officeDayTypeOptions("Apprentice", null)).toEqual(["sick", "holiday", "tafe"]);
    expect(officeDayTypeOptions(null, "tafe")).toEqual(["sick", "holiday", "tafe"]);
  });
});
