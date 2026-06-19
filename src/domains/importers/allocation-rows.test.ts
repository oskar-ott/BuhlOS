import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Time-entry allocation row builder. Pure mapping + quarantine: parent
 * time_entry resolution from (user uuid, date), job legacy→uuid resolution
 * (null = Internal, unresolved = quarantine), hours>0, allocation-sum==total,
 * and the canonicaliser that drives "replace only if changed" idempotency
 * (order-independent; JS number vs numeric(4,2) string compare equal).
 */

const requireFromHere = createRequire(import.meta.url);
const p = requireFromHere.resolve("../../../scripts/importers/lib/allocation-rows.js");
const mod = requireFromHere(p) as {
  buildAllocationRows: (input: {
    records?: Array<{ userId: string; date: string; entry: unknown }>;
    userMap?: Map<string, string>;
    jobMap?: Map<string, string>;
    timeEntryMap?: Map<string, string>;
  }) => {
    byEntry: Array<{ timeEntryId: string; rows: Array<Record<string, unknown>>; canonical: string }>;
    quarantine: Array<{ ref: string; reason: string }>;
  };
  canonicaliseAllocations: (rows: Array<Record<string, unknown>>) => string;
  ALLOCATION_INSERT_COLS: string[];
};
const { buildAllocationRows, canonicaliseAllocations, ALLOCATION_INSERT_COLS } = mod;

const USER = new Map([["u1", "uu1"]]);
const JOB = new Map([["j1", "jj1"]]);
const TE = new Map([["uu1|2026-06-01", "te1"]]);

function rec(allocations: unknown, totalHours = 7.6, over: { userId?: string; date?: string } = {}) {
  return {
    userId: over.userId ?? "u1",
    date: over.date ?? "2026-06-01",
    entry: { id: "e1", totalHours, allocations },
  };
}
function build(records: Array<{ userId: string; date: string; entry: unknown }>) {
  return buildAllocationRows({ records, userMap: USER, jobMap: JOB, timeEntryMap: TE });
}

describe("buildAllocationRows", () => {
  it("maps a clean internal (no-job) allocation", () => {
    const { byEntry, quarantine } = build([rec([{ jobId: null, hours: 7.6, notes: null, sortOrder: 0 }])]);
    expect(quarantine).toHaveLength(0);
    expect(byEntry).toHaveLength(1);
    expect(byEntry[0]!.timeEntryId).toBe("te1");
    expect(byEntry[0]!.rows).toEqual([{ job_id: null, hours: 7.6, notes: null, sort_order: 0 }]);
  });

  it("resolves a job legacy id to its uuid", () => {
    const { byEntry } = build([rec([{ jobId: "j1", hours: 7.6, sortOrder: 0 }])]);
    expect(byEntry[0]!.rows[0]!.job_id).toBe("jj1");
  });

  it("splits across jobs when the hours sum to the total", () => {
    const { byEntry, quarantine } = build([
      rec([{ jobId: "j1", hours: 5, sortOrder: 0 }, { jobId: null, hours: 2.6, sortOrder: 1 }]),
    ]);
    expect(quarantine).toHaveLength(0);
    expect(byEntry[0]!.rows).toHaveLength(2);
  });

  it("quarantines unresolved user / time_entry / job refs", () => {
    expect(build([rec([{ jobId: null, hours: 7.6 }], 7.6, { userId: "ghost" })]).quarantine[0]!.reason).toMatch(/user not imported/);
    expect(build([rec([{ jobId: null, hours: 7.6 }], 7.6, { date: "2026-06-09" })]).quarantine[0]!.reason).toMatch(/no time_entry/);
    expect(build([rec([{ jobId: "ghost", hours: 7.6 }])]).quarantine[0]!.reason).toMatch(/not imported/);
  });

  it("quarantines hours<=0 and allocation-sum != total", () => {
    expect(build([rec([{ jobId: null, hours: 0 }])]).quarantine[0]!.reason).toMatch(/hours must be > 0/);
    const mismatch = build([rec([{ jobId: null, hours: 5, sortOrder: 0 }], 7.6)]);
    expect(mismatch.byEntry).toHaveLength(0);
    expect(mismatch.quarantine[0]!.reason).toMatch(/!= total/);
  });

  it("ALLOCATION_INSERT_COLS covers the row keys plus tenant_id + time_entry_id", () => {
    const { byEntry } = build([rec([{ jobId: null, hours: 7.6, sortOrder: 0 }])]);
    expect(new Set(ALLOCATION_INSERT_COLS)).toEqual(
      new Set(["tenant_id", "time_entry_id", ...Object.keys(byEntry[0]!.rows[0]!)])
    );
  });
});

describe("canonicaliseAllocations", () => {
  it("is order-independent and equates a JS number with a numeric(4,2) string", () => {
    const proposed = [{ job_id: "jj1", hours: 5, notes: null, sort_order: 0 }, { job_id: null, hours: 2.6, notes: null, sort_order: 1 }];
    const fromPg = [{ job_id: null, hours: "2.60", notes: null, sort_order: 1 }, { job_id: "jj1", hours: "5.00", notes: null, sort_order: 0 }];
    expect(canonicaliseAllocations(fromPg)).toBe(canonicaliseAllocations(proposed));
  });

  it("differs when hours, job, notes, or count change", () => {
    const base = [{ job_id: null, hours: 7.6, notes: null, sort_order: 0 }];
    expect(canonicaliseAllocations([{ job_id: null, hours: 7.5, notes: null, sort_order: 0 }])).not.toBe(canonicaliseAllocations(base));
    expect(canonicaliseAllocations([{ job_id: "jj1", hours: 7.6, notes: null, sort_order: 0 }])).not.toBe(canonicaliseAllocations(base));
    expect(canonicaliseAllocations([{ job_id: null, hours: 7.6, notes: "x", sort_order: 0 }])).not.toBe(canonicaliseAllocations(base));
    expect(canonicaliseAllocations([])).not.toBe(canonicaliseAllocations(base));
  });
});
