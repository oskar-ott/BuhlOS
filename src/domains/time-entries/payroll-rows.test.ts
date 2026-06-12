import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * #380 — per-allocation ordinary/overtime proration conserves the entry's
 * stored day totals. The documented rule: ordinary budget is consumed in
 * allocation order; overtime lands on the last allocation(s).
 */

const requireFromHere = createRequire(import.meta.url);
const { prorateAllocations } = requireFromHere("../../../api/_lib/payroll-rows.js") as {
  prorateAllocations: (
    entry: { ordinaryHours?: number | null; overtimeHours?: number | null },
    allocations: Array<{ hours: number }>,
  ) => Array<{ hours: number; ordinaryHours: number; overtimeHours: number }>;
};

function sums(rows: Array<{ ordinaryHours: number; overtimeHours: number }>) {
  return rows.reduce(
    (acc, r) => ({ ord: acc.ord + r.ordinaryHours, ot: acc.ot + r.overtimeHours }),
    { ord: 0, ot: 0 },
  );
}

describe("prorateAllocations (#380)", () => {
  it("THE bug fixture: 10h day (8 ord + 2 OT) split 5+5 → rows sum 8/2, OT on the last", () => {
    const rows = prorateAllocations({ ordinaryHours: 8, overtimeHours: 2 }, [
      { hours: 5 },
      { hours: 5 },
    ]);
    expect(rows).toEqual([
      { hours: 5, ordinaryHours: 5, overtimeHours: 0 },
      { hours: 5, ordinaryHours: 3, overtimeHours: 2 },
    ]);
    expect(sums(rows)).toEqual({ ord: 8, ot: 2 });
  });

  it("single-allocation days match the previous derivation exactly", () => {
    // stored ordinaryHours present
    expect(prorateAllocations({ ordinaryHours: 8 }, [{ hours: 10 }])).toEqual([
      { hours: 10, ordinaryHours: 8, overtimeHours: 2 },
    ]);
    // legacy entry without stored ordinaryHours → old 8h default
    expect(prorateAllocations({}, [{ hours: 10 }])).toEqual([
      { hours: 10, ordinaryHours: 8, overtimeHours: 2 },
    ]);
    expect(prorateAllocations({}, [{ hours: 6 }])).toEqual([
      { hours: 6, ordinaryHours: 6, overtimeHours: 0 },
    ]);
  });

  it("three-way split consumes the budget in order", () => {
    const rows = prorateAllocations({ ordinaryHours: 8 }, [
      { hours: 4 },
      { hours: 4 },
      { hours: 3 },
    ]);
    expect(rows.map((r) => [r.ordinaryHours, r.overtimeHours])).toEqual([
      [4, 0],
      [4, 0],
      [0, 3],
    ]);
  });

  it("fractional hours conserve with 2dp rounding (no drift)", () => {
    const rows = prorateAllocations({ ordinaryHours: 7.6 }, [
      { hours: 3.8 },
      { hours: 3.8 },
      { hours: 1.9 },
    ]);
    const { ord, ot } = sums(rows);
    expect(Math.round(ord * 100) / 100).toBe(7.6);
    expect(Math.round(ot * 100) / 100).toBe(1.9);
  });

  it("a whole-day-overtime entry (ordinaryHours 0) marks every row OT", () => {
    const rows = prorateAllocations({ ordinaryHours: 0 }, [{ hours: 4 }, { hours: 2 }]);
    expect(sums(rows)).toEqual({ ord: 0, ot: 6 });
  });
});
