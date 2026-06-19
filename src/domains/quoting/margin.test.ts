import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
  computeQuoteMargin,
  type QuoteMarginInput,
  type QuoteMarginTotals,
} from "./margin";

/**
 * Parity-first coverage for the #214 pure quote-margin calculator.
 *
 * THE LIVE ORACLE: api/quotes.js exports `computeQuoteTotals` (CJS,
 * `module.exports.computeQuoteTotals`). We require it here and run the SAME
 * fixtures through it, asserting `computeQuoteMargin` returns a BYTE-IDENTICAL
 * totals object. This makes full-port parity an executable contract, not a
 * hand-derived comment — exactly the labour-calc.test.ts pattern, scaled to the
 * whole pricing pipeline.
 */
const requireFromHere = createRequire(import.meta.url);
const legacy = requireFromHere("../../../api/quotes.js") as {
  computeQuoteTotals: (sections: QuoteMarginInput) => QuoteMarginTotals;
};

/** Run a fixture through BOTH and return the pair for a deep-equality assert. */
function pair(input: QuoteMarginInput) {
  return { ours: computeQuoteMargin(input), oracle: legacy.computeQuoteTotals(input) };
}

/** The core parity assertion: ours === the live legacy oracle, field-for-field. */
function expectParity(input: QuoteMarginInput): QuoteMarginTotals {
  const { ours, oracle } = pair(input);
  expect(ours).toEqual(oracle);
  return ours;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const STD_PRICING = {
  materialMarkupPct: { default: 25, Cable: 40, Switchgear: 10 },
  labourSellRate: 95,
  labourCostMode: "per-line" as const,
  labourCostRate: 65,
  contingencyPct: 0,
  gstPct: 10,
  overrideTotalExGst: null,
};

describe("computeQuoteMargin — full parity with legacy computeQuoteTotals", () => {
  it("per-category markup incl. a MISSING category → default fallback", () => {
    const input: QuoteMarginInput = {
      pricing: STD_PRICING,
      materials: {
        items: [
          { quantity: 10, unitCost: 5, category: "Cable" }, // 50 cost @40% → 70 sell
          { quantity: 2, unitCost: 100, category: "Switchgear" }, // 200 @10% → 220
          { quantity: 4, unitCost: 25, category: "Conduit" }, // MISSING → default 25% → 100→125
          { quantity: 1, unitCost: 80 }, // no category → 'Other' → default 25% → 80→100
        ],
      },
      labour: { lines: [{ estimatedHours: 8, crewSize: 1, hourlyRate: 70, riskFactor: 1 }] },
      provisional: { items: [] },
    };
    const t = expectParity(input);
    // Breakdown ordering + default fallback are part of the deep-equal; spot-check.
    const cats = t.materials.breakdown.map((b) => b.category);
    expect(cats).toEqual(["Cable", "Switchgear", "Conduit", "Other"]);
    expect(t.materials.breakdown.find((b) => b.category === "Conduit")?.markupPct).toBe(25);
    expect(t.materials.breakdown.find((b) => b.category === "Other")?.markupPct).toBe(25);
  });

  it("labour per-line mode incl. per-line null hourlyRate → labourCostRate fallback", () => {
    const input: QuoteMarginInput = {
      pricing: STD_PRICING,
      materials: { items: [] },
      labour: {
        lines: [
          { estimatedHours: 4, crewSize: 2, hourlyRate: 80, riskFactor: 1 }, // adj 8h @80
          { estimatedHours: 3, crewSize: 1, hourlyRate: null, riskFactor: 1 }, // adj 3h @65 fallback
        ],
      },
      provisional: { items: [] },
    };
    const t = expectParity(input);
    // labCost = 8*80 + 3*65 = 835; labSell = 11*95 = 1045
    expect(t.labour).toMatchObject({ hours: 11, cost: 835, sell: 1045, sellRate: 95 });
  });

  it("labour shared mode forces labourCostRate (ignores per-line hourlyRate)", () => {
    const input: QuoteMarginInput = {
      pricing: { ...STD_PRICING, labourCostMode: "shared", labourCostRate: 70 },
      materials: { items: [] },
      labour: {
        lines: [
          { estimatedHours: 5, crewSize: 1, hourlyRate: 200, riskFactor: 1 }, // hourlyRate IGNORED
          { estimatedHours: 2, crewSize: 2, hourlyRate: null, riskFactor: 1 },
        ],
      },
      provisional: { items: [] },
    };
    const t = expectParity(input);
    // hours 5 + 4 = 9; cost 9*70 = 630; sell 9*95 = 855
    expect(t.labour).toMatchObject({ hours: 9, cost: 630, sell: 855 });
  });

  it("crewSize × riskFactor hour adjustment; riskFactor 0 → 1.0, crewSize 0 → 1", () => {
    const input: QuoteMarginInput = {
      pricing: STD_PRICING,
      materials: { items: [] },
      labour: {
        lines: [
          { estimatedHours: 6, crewSize: 0, hourlyRate: 60, riskFactor: 1 }, // crewSize 0 → 1 → 6h
          { estimatedHours: 4, crewSize: 1, hourlyRate: 50, riskFactor: 0 }, // risk 0 → 1.0 → 4h
          { estimatedHours: 2, crewSize: 3, hourlyRate: 100, riskFactor: 2 }, // 2*3*2 = 12h
        ],
      },
      provisional: { items: [] },
    };
    const t = expectParity(input);
    // hours 6 + 4 + 12 = 22
    expect(t.labour.hours).toBe(22);
  });

  it("provisional sums EXCLUDED from margin but included in subtotal", () => {
    const input: QuoteMarginInput = {
      pricing: STD_PRICING,
      materials: { items: [{ quantity: 1, unitCost: 100, category: "Cable" }] }, // 100 @40 → 140 sell
      labour: { lines: [{ estimatedHours: 10, crewSize: 1, hourlyRate: 65, riskFactor: 1 }] }, // 650 cost / 950 sell
      provisional: { items: [{ amountExGst: 500 }, { amountExGst: 250 }] }, // 750 face value
    };
    const t = expectParity(input);
    expect(t.provisional).toEqual({ total: 750, count: 2 });
    // margin scope = materials + labour only: cost 100+650 = 750, sell 140+950 = 1090
    expect(t.totalCost).toBe(750);
    expect(t.totalSell).toBe(1090);
    // subtotal INCLUDES provisional: 140 + 950 + 750 = 1840
    expect(t.subtotalExGst).toBe(1840);
  });

  it("contingency EXCLUDED from margin but added to subtotal", () => {
    const input: QuoteMarginInput = {
      pricing: { ...STD_PRICING, contingencyPct: 10 },
      materials: { items: [{ quantity: 1, unitCost: 100, category: "Switchgear" }] }, // 100 @10 → 110
      labour: { lines: [{ estimatedHours: 10, crewSize: 1, hourlyRate: 65, riskFactor: 1 }] }, // 650 / 950
      provisional: { items: [] },
    };
    const t = expectParity(input);
    // subBeforeContingency = 110 + 950 = 1060; contingency = 106; subtotal = 1166
    expect(t.contingency).toEqual({ pct: 10, amount: 106 });
    expect(t.subtotalExGst).toBe(1166);
    // margin scope is materials+labour ONLY (contingency not in numerator)
    expect(t.totalCost).toBe(750); // 100 + 650
    expect(t.totalSell).toBe(1060); // 110 + 950
  });

  it("overrideTotalExGst replaces the computed subtotal and sets overridden", () => {
    const input: QuoteMarginInput = {
      pricing: { ...STD_PRICING, overrideTotalExGst: 5000 },
      materials: { items: [{ quantity: 1, unitCost: 100, category: "Cable" }] },
      labour: { lines: [{ estimatedHours: 10, crewSize: 1, hourlyRate: 65, riskFactor: 1 }] },
      provisional: { items: [] },
    };
    const t = expectParity(input);
    expect(t.overridden).toBe(true);
    expect(t.subtotalExGst).toBe(5000);
    expect(t.gst).toBe(500);
    expect(t.totalIncGst).toBe(5500);
    // margin still computed on the real cost/sell, NOT the override
    expect(t.totalCost).toBe(750);
    expect(t.totalSell).toBe(1090);
  });

  it("negative category markup is allowed (PATCH permits −50%)", () => {
    const input: QuoteMarginInput = {
      pricing: { ...STD_PRICING, materialMarkupPct: { default: 25, Loss: -50 } },
      materials: { items: [{ quantity: 1, unitCost: 200, category: "Loss" }] }, // 200 @ -50% → 100 sell
      labour: { lines: [] },
      provisional: { items: [] },
    };
    const t = expectParity(input);
    expect(t.materials.cost).toBe(200);
    expect(t.materials.sell).toBe(100); // sold below cost
    expect(t.materials.breakdown[0]).toMatchObject({ category: "Loss", markupPct: -50 });
    // margin goes negative: sell 100 - cost 200 = -100
    expect(t.margin.amount).toBe(-100);
  });

  it("totalCost-falsy-precedence: totalCost === 0 falls through to unitCost*qty", () => {
    const input: QuoteMarginInput = {
      pricing: STD_PRICING,
      materials: {
        items: [
          { quantity: 5, unitCost: 20, totalCost: 0, category: "Cable" }, // totalCost 0 → falls to 5*20=100
          { quantity: 2, unitCost: 30, totalCost: 250, category: "Cable" }, // totalCost 250 used (not 60)
        ],
      },
      labour: { lines: [] },
      provisional: { items: [] },
    };
    const t = expectParity(input);
    // line 1 cost = 100 (NOT 0), line 2 cost = 250 (NOT 60) → matCost 350
    expect(t.materials.cost).toBe(350);
  });

  it("non-finite line cost is skipped (legacy `if (!isFinite) continue`)", () => {
    const input: QuoteMarginInput = {
      pricing: STD_PRICING,
      materials: {
        items: [
          { quantity: 1, unitCost: Number.POSITIVE_INFINITY, category: "Cable" }, // skipped
          { quantity: 2, unitCost: 50, category: "Cable" }, // 100 cost
        ],
      },
      labour: { lines: [] },
      provisional: { items: [] },
    };
    const t = expectParity(input);
    expect(t.materials.cost).toBe(100);
  });

  it("round2/round1 parity on fractional inputs", () => {
    const input: QuoteMarginInput = {
      pricing: { ...STD_PRICING, materialMarkupPct: { default: 33.33 } },
      materials: { items: [{ quantity: 3, unitCost: 9.99, category: "Bits" }] }, // 29.97 cost @33.33%
      labour: { lines: [{ estimatedHours: 1.333, crewSize: 1, hourlyRate: 71.5, riskFactor: 1.07 }] },
      provisional: { items: [{ amountExGst: 12.345 }] },
    };
    // no hand numbers — the live oracle is the source of truth for the rounding
    expectParity(input);
  });

  it("empty quote → all zeros, 0% margin, not overridden", () => {
    const t = expectParity({ pricing: STD_PRICING, materials: { items: [] }, labour: { lines: [] }, provisional: { items: [] } });
    expect(t).toMatchObject({
      materials: { cost: 0, sell: 0, breakdown: [] },
      labour: { hours: 0, cost: 0, sell: 0 },
      provisional: { total: 0, count: 0 },
      subtotalExGst: 0,
      totalCost: 0,
      totalSell: 0,
      margin: { amount: 0, pct: 0 },
      overridden: false,
    });
  });

  it("defaults applied when pricing omitted entirely (Object.assign parity)", () => {
    // No pricing → PRICING_DEFAULTS: 25% default markup, sell 95 / cost 65, gst 10.
    const input: QuoteMarginInput = {
      materials: { items: [{ quantity: 1, unitCost: 100 }] }, // 100 @25% → 125
      labour: { lines: [{ estimatedHours: 2, crewSize: 1, riskFactor: 1 }] }, // null hourlyRate → 65
    };
    const t = expectParity(input);
    expect(t.materials.sell).toBe(125);
    expect(t.labour.cost).toBe(130); // 2 * 65
    expect(t.labour.sell).toBe(190); // 2 * 95
    expect(t.gstPct).toBe(10);
  });

  it("sub-cent multi-line quote: margin differenced UNROUNDED, rounded once", () => {
    // Materials + labour that both carry sub-cent fractions, so a round-then-
    // difference margin would drift a cent from the oracle. expectParity asserts
    // the WHOLE object equals legacy, so this fails if the margin is ever derived
    // from rounded section totals.
    const input: QuoteMarginInput = {
      pricing: { ...STD_PRICING, materialMarkupPct: { default: 17.5 } },
      materials: {
        items: [
          { quantity: 3, unitCost: 9.97, category: "A" },
          { quantity: 7, unitCost: 1.015, category: "B" },
        ],
      },
      labour: {
        lines: [
          { estimatedHours: 1.5, crewSize: 1, hourlyRate: 95, riskFactor: 0.9 },
          { estimatedHours: 2.5, crewSize: 3, hourlyRate: 85.5, riskFactor: 1.05 },
        ],
      },
      provisional: { items: [{ amountExGst: 33.337 }] },
    };
    expectParity(input);
  });
});
