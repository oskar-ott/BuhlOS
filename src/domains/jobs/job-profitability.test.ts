import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * #327 — per-job profitability. The margin maths plus the HONEST completeness
 * statement: never a fabricated margin, never a silent 0-rate contribution,
 * material source always labelled. CJS (api/_lib/job-profitability.js) so the
 * serverless handler can require it.
 */
const requireFromHere = createRequire(import.meta.url);
type Line = { actualCents: number; budgetCents: number | null; varianceCents: number | null; variancePct: number | null };
const { computeJobProfitability, computeBudgetVariance, buildBudgetLines } = requireFromHere(
  "../../../api/_lib/job-profitability.js",
) as {
  computeJobProfitability: (input: Record<string, unknown>) => {
    marginCents: number | null;
    marginPct: number | null;
    materialCostCents: number;
    completeness: { labour: string; material: string; unratedWorkers: string[] };
    badges: string[];
  };
  computeBudgetVariance: (actualCents: number, budgetCents: number | null) => Line;
  buildBudgetLines: (input: Record<string, unknown>) => { labour: Line; material: Line; total: Line };
};

describe("computeJobProfitability — margin + honest completeness", () => {
  it("computes revenue − labour − material in cents with a rounded %", () => {
    const p = computeJobProfitability({
      contractValueCents: 12_000_000, // $120,000
      labourCostCents: 4_462_500, // $44,625
      unratedWorkers: [],
      materialCostCents: 3_000_000, // $30,000
      materialSource: "received_proxy",
    });
    expect(p.marginCents).toBe(4_537_500); // $45,375
    expect(p.marginPct).toBe(38);
    expect(p.completeness.labour).toBe("complete");
    expect(p.badges).toEqual(["labour complete", "materials proxy"]);
  });

  it("returns a null margin (never a fake number) when there's no contract value", () => {
    const p = computeJobProfitability({
      contractValueCents: null,
      labourCostCents: 1000,
      unratedWorkers: [],
      materialCostCents: 0,
      materialSource: "none",
    });
    expect(p.marginCents).toBeNull();
    expect(p.marginPct).toBeNull();
    expect(p.badges).toContain("no contract value set");
  });

  it("flags labour as understated and names unrated workers (no silent 0-rate)", () => {
    const p = computeJobProfitability({
      contractValueCents: 1_000_000,
      labourCostCents: 200_000,
      unratedWorkers: ["Sparky", "Mate"],
      materialCostCents: null,
      materialSource: "none",
    });
    expect(p.completeness.labour).toBe("understated");
    expect(p.completeness.unratedWorkers).toEqual(["Sparky", "Mate"]);
    expect(p.badges).toContain("2 workers unrated");
    expect(p.badges).toContain("no material data");
  });

  it("labels the material source and treats null material cost as 0 for the maths", () => {
    const consumption = computeJobProfitability({
      contractValueCents: 1_000_000,
      labourCostCents: 0,
      unratedWorkers: [],
      materialCostCents: 250_000,
      materialSource: "consumption",
    });
    expect(consumption.completeness.material).toBe("consumption");
    expect(consumption.badges).toContain("materials actual");
    expect(consumption.marginCents).toBe(750_000);

    const none = computeJobProfitability({
      contractValueCents: 1_000_000,
      labourCostCents: 0,
      unratedWorkers: [],
      materialCostCents: null,
      materialSource: "none",
    });
    expect(none.materialCostCents).toBe(0);
    expect(none.marginCents).toBe(1_000_000);
  });

  it("margin can go negative (a job in the red is reported honestly)", () => {
    const p = computeJobProfitability({
      contractValueCents: 100_000,
      labourCostCents: 80_000,
      unratedWorkers: [],
      materialCostCents: 50_000,
      materialSource: "received_proxy",
    });
    expect(p.marginCents).toBe(-30_000);
    expect(p.marginPct).toBe(-30);
  });
});

describe("computeBudgetVariance / buildBudgetLines — actual vs budget (#341)", () => {
  it("computes variance $ and % (positive = over budget)", () => {
    expect(computeBudgetVariance(5_500_000, 5_000_000)).toEqual({
      actualCents: 5_500_000, budgetCents: 5_000_000, varianceCents: 500_000, variancePct: 10,
    });
    expect(computeBudgetVariance(4_000_000, 5_000_000)).toEqual({
      actualCents: 4_000_000, budgetCents: 5_000_000, varianceCents: -1_000_000, variancePct: -20,
    });
  });

  it("returns a null variance (never a fabricated 0) when no budget is set", () => {
    expect(computeBudgetVariance(100_000, null)).toEqual({
      actualCents: 100_000, budgetCents: null, varianceCents: null, variancePct: null,
    });
  });

  it("builds the three lines: labour, materials, total-vs-contract", () => {
    const lines = buildBudgetLines({
      labourCostCents: 4_000_000, materialCostCents: 3_000_000,
      labourEstimateCents: 3_500_000, materialEstimateCents: null, contractValueCents: 12_000_000,
    });
    expect(lines.labour.varianceCents).toBe(500_000); // over by $5k
    expect(lines.material.budgetCents).toBeNull(); // no material estimate → null
    expect(lines.total.actualCents).toBe(7_000_000); // labour + material
    expect(lines.total.varianceCents).toBe(7_000_000 - 12_000_000); // under contract value
  });
});
