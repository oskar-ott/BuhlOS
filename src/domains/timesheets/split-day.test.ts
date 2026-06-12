import { describe, expect, it } from "vitest";
import {
  allocationsSumValid,
  buildSplitDayPayload,
  splitDayRemainder,
} from "./service";

/**
 * #128 — split-day payload maths. The model/server already accept multiple
 * allocations; this pins the Phil-side builder + the auto-remainder so the
 * worker never does subtraction.
 */

describe("buildSplitDayPayload", () => {
  it("assembles one entry with multiple allocations + OT on the day total", () => {
    const p = buildSplitDayPayload({
      date: "2026-06-12",
      totalHours: 7.6,
      allocations: [
        { jobId: "j1", hours: 5 },
        { jobId: "j2", hours: 2.6 },
      ],
    });
    expect(p.totalHours).toBe(7.6);
    expect(p.allocations).toEqual([
      { jobId: "j1", hours: 5, notes: null },
      { jobId: "j2", hours: 2.6, notes: null },
    ]);
    expect(p.status).toBe("submitted");
    // OT split is on the total, not per job.
    expect(p.ordinaryHours + p.overtimeHours).toBeCloseTo(7.6, 5);
    // Allocations sum to the total (the schema rule).
    expect(allocationsSumValid(7.6, p.allocations)).toBe(true);
  });

  it("a 3-way split still sums", () => {
    const p = buildSplitDayPayload({
      date: "2026-06-12",
      totalHours: 9,
      allocations: [
        { jobId: "j1", hours: 4 },
        { jobId: "j2", hours: 3 },
        { jobId: "j3", hours: 2 },
      ],
    });
    expect(allocationsSumValid(9, p.allocations)).toBe(true);
  });
});

describe("splitDayRemainder", () => {
  it("computes the last row as total minus the earlier rows", () => {
    expect(splitDayRemainder(7.6, [5])).toBe(2.6);
    expect(splitDayRemainder(9, [4, 3])).toBe(2);
  });

  it("never goes negative (over-allocated rows clamp to 0)", () => {
    expect(splitDayRemainder(7.6, [5, 4])).toBe(0);
  });

  it("rounds to 0.1 so the sum doesn't fight the ±0.01 tolerance", () => {
    expect(splitDayRemainder(8, [2.33])).toBe(5.7);
  });
});
