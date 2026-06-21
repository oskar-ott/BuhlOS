import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
  computeMaterialLine,
  computeMaterialTotals,
  MATERIAL_CALC_DEFAULTS,
  type MaterialCalcSettings,
} from "./material-calc";
import type { QuoteMaterialItem } from "./margin";

/**
 * Parity-first coverage for the #195 pure material calculator.
 *
 * THE LIVE ORACLE: api/quotes.js exports `computeQuoteTotals` (CJS). We require
 * it and run the SAME material fixtures through it, asserting
 * `computeMaterialTotals` returns a BYTE-IDENTICAL `.materials` block ({ cost,
 * sell, breakdown }). Same pattern as labour-calc.test.ts / margin.test.ts.
 */
const requireFromHere = createRequire(import.meta.url);
const legacy = requireFromHere("../../../api/quotes.js") as {
  computeQuoteTotals: (input: {
    pricing?: unknown;
    materials?: { items?: QuoteMaterialItem[] } | null;
  }) => { materials: { cost: number; sell: number; breakdown: unknown[] } };
};

/** Settings shared by both sides. Materials-only subset of legacy PRICING_DEFAULTS. */
const STD: MaterialCalcSettings = {
  materialMarkupPct: { default: 25, Cable: 40, Switchgear: 10, Free: -50 },
};

/** Run items through BOTH and assert our totals == the live oracle's .materials,
 *  ignoring our additive `unpricedCount` (which the oracle doesn't carry). */
function expectParity(items: QuoteMaterialItem[], settings: MaterialCalcSettings = STD) {
  const ours = computeMaterialTotals(items, settings);
  const oracle = legacy.computeQuoteTotals({ pricing: settings, materials: { items } }).materials;
  const { unpricedCount, ...oursComparable } = ours;
  void unpricedCount;
  expect(oursComparable).toEqual(oracle);
  return ours;
}

describe("computeMaterialTotals — parity with legacy computeQuoteTotals.materials", () => {
  it("per-category markup incl. a MISSING category → default fallback", () => {
    expectParity([
      { quantity: 10, unitCost: 5, category: "Cable" }, // 50 @40% → 70
      { quantity: 2, unitCost: 100, category: "Switchgear" }, // 200 @10% → 220
      { quantity: 4, unitCost: 25, category: "Conduit" }, // MISSING → default 25% → 100 → 125
    ]);
  });

  it("totalCost falsy precedence: totalCost===0 falls through to unitCost*qty", () => {
    const r = expectParity([{ quantity: 3, unitCost: 10, totalCost: 0, category: "Cable" }]);
    expect(r.cost).toBe(30); // 0 is falsy → 10*3
  });

  it("totalCost wins when truthy (ignores unitCost*qty)", () => {
    const r = expectParity([{ quantity: 99, unitCost: 999, totalCost: 250, category: "Cable" }]);
    expect(r.cost).toBe(250);
  });

  it("missing category → 'Other' → default markup", () => {
    const r = expectParity([{ quantity: 1, unitCost: 80 }]);
    expect(r.breakdown[0]!.category).toBe("Other");
    expect(r.breakdown[0]!.markupPct).toBe(25);
  });

  it("negative category markup is allowed (sell below cost)", () => {
    const r = expectParity([{ quantity: 1, unitCost: 100, category: "Free" }]); // -50% → 50
    expect(r.sell).toBe(50);
  });

  it("first-seen markupPct per category is stamped; breakdown is first-seen order", () => {
    const r = expectParity([
      { quantity: 1, unitCost: 10, category: "Cable" },
      { quantity: 1, unitCost: 20, category: "Switchgear" },
      { quantity: 1, unitCost: 30, category: "Cable" }, // same category, accumulates
    ]);
    expect(r.breakdown.map((b) => b.category)).toEqual(["Cable", "Switchgear"]);
    expect(r.breakdown[0]!.count).toBe(2);
  });

  it("fractional qty + many lines: sum-unrounded-round-once parity (no per-line drift)", () => {
    const items: QuoteMaterialItem[] = Array.from({ length: 7 }, (_, i) => ({
      quantity: 0.333,
      unitCost: 1.005 + i * 0.01,
      category: "Cable",
    }));
    expectParity(items);
  });

  it("empty list → zero totals, empty breakdown", () => {
    const r = expectParity([]);
    expect(r).toMatchObject({ cost: 0, sell: 0, breakdown: [] });
  });

  it("qty 0 with a unit rate → 0 cost but still priced (parity)", () => {
    const r = expectParity([{ quantity: 0, unitCost: 50, category: "Cable" }]);
    expect(r.cost).toBe(0);
    expect(r.unpricedCount).toBe(0); // has a unit rate → priced, just zero qty
  });

  it("uses the {default:25} table when settings omit materialMarkupPct (parity)", () => {
    const r = expectParity([{ quantity: 2, unitCost: 50, category: "Anything" }], {});
    expect(r.breakdown[0]!.markupPct).toBe(25);
  });
});

describe("computeMaterialTotals — additive #195 honesty (never changes the numbers)", () => {
  it("counts unpriced lines (no usable totalCost AND no unitCost) without faking $0", () => {
    const items: QuoteMaterialItem[] = [
      { quantity: 5, category: "Cable" }, // no price → unpriced
      { quantity: 5, totalCost: 0, category: "Cable" }, // 0 totalCost, no unit → unpriced
      { quantity: 2, unitCost: 10, category: "Cable" }, // priced
    ];
    const ours = computeMaterialTotals(items, STD);
    expect(ours.unpricedCount).toBe(2);
    // The numbers still match legacy exactly (additive flag changes nothing).
    expectParity(items);
  });
});

describe("computeMaterialLine — display rounding", () => {
  it("rounds cost/sell per line and resolves category + markup", () => {
    const r = computeMaterialLine({ quantity: 3, unitCost: 9.999, category: "Cable" }, STD);
    expect(r.category).toBe("Cable");
    expect(r.markupPct).toBe(40);
    expect(r.cost).toBe(30); // round2(29.997)
    expect(r.sell).toBe(round2(29.997 * 1.4));
    expect(r.unpriced).toBe(false);
  });

  it("flags an unpriced line and a skipped (non-finite) line", () => {
    expect(computeMaterialLine({ quantity: 1, category: "Cable" }, STD).unpriced).toBe(true);
    expect(computeMaterialLine({ unitCost: Infinity, quantity: 1 }, STD).skipped).toBe(true);
  });

  it("defaults settings to MATERIAL_CALC_DEFAULTS", () => {
    const r = computeMaterialLine({ quantity: 1, unitCost: 100 });
    expect(r.markupPct).toBe(MATERIAL_CALC_DEFAULTS.materialMarkupPct!.default);
  });
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
