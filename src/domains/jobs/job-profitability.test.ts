import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * #327 — per-job profitability. The margin maths plus the HONEST completeness
 * statement: never a fabricated margin, never a silent 0-rate contribution,
 * material source always labelled. CJS (api/_lib/job-profitability.js) so the
 * serverless handler can require it.
 */
const requireFromHere = createRequire(import.meta.url);
const { computeJobProfitability } = requireFromHere(
  "../../../api/_lib/job-profitability.js",
) as {
  computeJobProfitability: (input: Record<string, unknown>) => {
    marginCents: number | null;
    marginPct: number | null;
    materialCostCents: number;
    completeness: { labour: string; material: string; unratedWorkers: string[] };
    badges: string[];
  };
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
