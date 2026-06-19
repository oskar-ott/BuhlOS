import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
  computeQuoteMargin,
  computeQuoteMarginSections,
  DEFAULT_LOW_MARGIN_THRESHOLD_PCT,
  QUOTE_MARGIN_INTERNAL_ONLY_KEYS,
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

// ════════════════════════════════════════════════════════════════════════════
// #214 commit 2 — per-section attribution + flags + override effective margin +
// internal-only boundary.
// ════════════════════════════════════════════════════════════════════════════

const round2 = (n: number) => Math.round(n * 100) / 100;

describe("computeQuoteMarginSections — sections sum to the rollup", () => {
  /** The margin-scope invariant: Materials + Labour section costs/sells reduce
   *  (round2 of the summed rounded section values) to the rollup totalCost /
   *  totalSell. Provisional is excluded (legacy excludes it from the numerator). */
  function expectSectionsSumToRollup(input: QuoteMarginInput) {
    const { sections, rollup } = computeQuoteMarginSections(input);
    const marginScope = sections.filter((s) => s.section === "materials" || s.section === "labour");
    const costSum = round2(marginScope.reduce((acc, s) => acc + s.cost, 0));
    const sellSum = round2(marginScope.reduce((acc, s) => acc + s.sell, 0));
    // Display reconciliation: Σ(round2 section) is within ONE rounding cent of the
    // rollup (round-then-sum vs sum-then-round). round2 the diff to shed float
    // epsilon (65.14 − 65.13 = 0.0100000…05). The rollup is the exact figure.
    expect(round2(Math.abs(costSum - rollup.cost))).toBeLessThanOrEqual(0.01);
    expect(round2(Math.abs(sellSum - rollup.sell))).toBeLessThanOrEqual(0.01);
    // The rollup itself is oracle-EXACT (this is the real correctness property).
    const oracle = computeQuoteMargin(input);
    expect(rollup.cost).toBe(oracle.totalCost);
    expect(rollup.sell).toBe(oracle.totalSell);
    // Materials category sub-rows reconcile to the Materials parent within a cent.
    const mat = sections.find((s) => s.section === "materials")!;
    if (mat.subRows.length) {
      expect(round2(Math.abs(round2(mat.subRows.reduce((a, s) => a + s.cost, 0)) - mat.cost))).toBeLessThanOrEqual(0.01);
      expect(round2(Math.abs(round2(mat.subRows.reduce((a, s) => a + s.sell, 0)) - mat.sell))).toBeLessThanOrEqual(0.01);
    }
  }

  it("invariant holds on a mixed quote", () => {
    expectSectionsSumToRollup({
      pricing: { materialMarkupPct: { default: 25, Cable: 40, Switchgear: 10 } },
      materials: {
        items: [
          { quantity: 10, unitCost: 5, category: "Cable" },
          { quantity: 2, unitCost: 100, category: "Switchgear" },
          { quantity: 4, unitCost: 25, category: "Conduit" },
        ],
      },
      labour: { lines: [{ estimatedHours: 8, crewSize: 2, hourlyRate: 70, riskFactor: 1.1 }] },
      provisional: { items: [{ amountExGst: 500 }] },
    });
  });

  it("invariant holds on a sub-cent quote (rounding can't break the sum)", () => {
    expectSectionsSumToRollup({
      pricing: { materialMarkupPct: { default: 17.5 } },
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
    });
  });

  it("reconciles within a cent when round-then-sum drifts (documented artifact, not exact)", () => {
    // Two $1 categories at 17.5%: each sub-row sells round2(1.175)=1.18, Σ=2.36,
    // but the parent is round2(2.35)=2.35 — a 1¢ round-then-sum artifact. And
    // materials cost 2.00 + labour 63.135 gives Σ(section cost) 65.14 vs the
    // oracle-exact rollup 65.13. Both reconcile within a cent; the rollup is exact.
    const input: QuoteMarginInput = {
      pricing: { materialMarkupPct: { default: 17.5 }, labourCostRate: 61 },
      materials: { items: [
        { quantity: 1, unitCost: 1, category: "A" },
        { quantity: 1, unitCost: 1, category: "B" },
      ] },
      labour: { lines: [{ estimatedHours: 1, crewSize: 1, hourlyRate: 61, riskFactor: 1.035 }] },
    };
    expectSectionsSumToRollup(input); // passes via the ≤1¢ tolerance
    const { sections, rollup } = computeQuoteMarginSections(input);
    const oracle = computeQuoteMargin(input);
    expect(rollup.cost).toBe(oracle.totalCost); // rollup is oracle-exact
    expect(rollup.sell).toBe(oracle.totalSell);
    // The displayed parts genuinely drift a cent — proves the tolerance isn't vacuous.
    const mat = sections.find((s) => s.section === "materials")!;
    expect(round2(mat.subRows.reduce((a, s) => a + s.sell, 0))).not.toBe(mat.sell); // 2.36 vs 2.35
    const secCostSum = round2(
      sections.filter((s) => s.section === "materials" || s.section === "labour").reduce((a, s) => a + s.cost, 0),
    );
    expect(secCostSum).not.toBe(rollup.cost); // 65.14 vs 65.13
  });

  it("invariant holds with only materials, only labour, and an empty quote", () => {
    expectSectionsSumToRollup({ materials: { items: [{ quantity: 2, unitCost: 50 }] }, labour: { lines: [] } });
    expectSectionsSumToRollup({ materials: { items: [] }, labour: { lines: [{ estimatedHours: 5, hourlyRate: 60 }] } });
    expectSectionsSumToRollup({ materials: { items: [] }, labour: { lines: [] } });
  });

  it("section order is Materials, Labour, Provisional, then the quote rollup", () => {
    const { sections } = computeQuoteMarginSections({
      materials: { items: [{ quantity: 1, unitCost: 10 }] },
      labour: { lines: [{ estimatedHours: 1, hourlyRate: 60 }] },
      provisional: { items: [{ amountExGst: 5 }] },
    });
    expect(sections.map((s) => s.section)).toEqual(["materials", "labour", "provisional", "quote"]);
  });

  it("provisional row is sell == cost == psTotal with margin 0", () => {
    const { sections } = computeQuoteMarginSections({
      materials: { items: [] },
      labour: { lines: [] },
      provisional: { items: [{ amountExGst: 300 }, { amountExGst: 200 }] },
    });
    const ps = sections.find((s) => s.section === "provisional")!;
    expect(ps).toMatchObject({ cost: 500, sell: 500, margin: { amount: 0, pct: 0 }, flag: "ok" });
  });
});

describe("zero-sell honesty — null pct, loss still visible (NOT 0% / NaN / −100%)", () => {
  it("a section with >0 cost and 0 sell → pct null, amount = −cost, flag negative", () => {
    // Material sold at −100% markup → sell 0, cost > 0. Legacy rollup would call
    // this margin 0% (totalSell 0 → pct 0); we DELIBERATELY diverge for the
    // section: pct null (UI '—') with amount = −cost so the loss is unmissable.
    const { sections } = computeQuoteMarginSections({
      pricing: { materialMarkupPct: { default: -100 } },
      materials: { items: [{ quantity: 1, unitCost: 250, category: "WriteOff" }] },
      labour: { lines: [] },
    });
    const mat = sections.find((s) => s.section === "materials")!;
    expect(mat.sell).toBe(0);
    expect(mat.cost).toBe(250);
    expect(mat.margin.pct).toBeNull(); // sentinel, NOT 0, NOT NaN
    expect(mat.margin.amount).toBe(-250); // the loss is visible
    expect(mat.flag).toBe("negative");
    expect(Number.isNaN(mat.margin.pct as unknown as number)).toBe(false);
  });

  it("an empty section (0 cost, 0 sell) → pct null but flag ok (nothing at risk)", () => {
    const { sections } = computeQuoteMarginSections({ materials: { items: [] }, labour: { lines: [] } });
    const mat = sections.find((s) => s.section === "materials")!;
    expect(mat).toMatchObject({ cost: 0, sell: 0, flag: "ok" });
    expect(mat.margin.pct).toBeNull();
    expect(mat.margin.amount).toBe(0);
  });

  it("legacy rollup margin stays 0% (the divergence is section-only)", () => {
    // The full-port rollup margin keeps legacy's 0% on a 0-sell quote — only the
    // per-SECTION attribution returns null. Both behaviours coexist by design.
    const input: QuoteMarginInput = {
      pricing: { materialMarkupPct: { default: -100 } },
      materials: { items: [{ quantity: 1, unitCost: 250 }] },
      labour: { lines: [] },
    };
    expect(computeQuoteMargin(input).margin.pct).toBe(0); // legacy contract intact
  });
});

describe("override effective margin — computed AND effective-under-override both present", () => {
  it("effectiveMargin recomputes margin against the override subtotal", () => {
    // cost: materials 100 + labour 650 = 750. computed sell: mat 140 + lab 950 +
    // provisional 200 = 1290 subtotal; margin scope sell = 1090.
    // Override subtotal 1000 → effectiveSell = 1000 − 200 (ps) − 0 (contingency)
    // = 800; effectiveAmount = 800 − 750 = 50; effectivePct = 50/800 = 6.25 → 6.3.
    const input: QuoteMarginInput = {
      pricing: { materialMarkupPct: { default: 40 }, overrideTotalExGst: 1000 },
      materials: { items: [{ quantity: 1, unitCost: 100, category: "Cable" }] },
      labour: { lines: [{ estimatedHours: 10, crewSize: 1, hourlyRate: 65, riskFactor: 1 }] },
      provisional: { items: [{ amountExGst: 200 }] },
    };
    const { rollup, effectiveMargin } = computeQuoteMarginSections(input);
    // computed margin (rollup) stays the REAL materials+labour margin
    expect(rollup.cost).toBe(750);
    expect(rollup.sell).toBe(1090);
    expect(rollup.margin.amount).toBe(340);
    // effective margin under the negotiated override
    expect(effectiveMargin).not.toBeNull();
    expect(effectiveMargin!.sell).toBe(800);
    expect(effectiveMargin!.amount).toBe(50);
    expect(effectiveMargin!.pct).toBe(6.3);
    expect(effectiveMargin!.flag).toBe("low"); // 6.3% < 15% default
  });

  it("effectiveMargin strips contingency too (like-for-like vs cost)", () => {
    // contingency 10% on subBeforeContingency. Override 2000.
    // mat 100 @25 → 125 sell, cost 100. lab 10h @65 cost 650 / @95 sell 950.
    // ps 0. subBefore = 125 + 950 = 1075; contingency = 107.5.
    // effectiveSell = 2000 − 0 (ps) − 107.5 (contingency) = 1892.5;
    // cost 750 → amount 1142.5; pct = 1142.5/1892.5*100 = 60.37… → 60.4
    const input: QuoteMarginInput = {
      pricing: { contingencyPct: 10, overrideTotalExGst: 2000 },
      materials: { items: [{ quantity: 1, unitCost: 100 }] },
      labour: { lines: [{ estimatedHours: 10, crewSize: 1, hourlyRate: 65, riskFactor: 1 }] },
      provisional: { items: [] },
    };
    const { effectiveMargin } = computeQuoteMarginSections(input);
    expect(effectiveMargin!.sell).toBe(1892.5);
    expect(effectiveMargin!.amount).toBe(1142.5);
    expect(effectiveMargin!.pct).toBe(60.4);
  });

  it("effectiveMargin is null when the quote is NOT overridden", () => {
    const { effectiveMargin } = computeQuoteMarginSections({
      materials: { items: [{ quantity: 1, unitCost: 100 }] },
      labour: { lines: [] },
    });
    expect(effectiveMargin).toBeNull();
  });
});

describe("low / negative flagging — negative is distinct from low", () => {
  it("flags negative on a loss, low on a thin positive margin, ok above threshold", () => {
    // Labour-only quotes give clean margin %s: sell 95/h, cost varies.
    const negative = computeQuoteMarginSections({
      // cost 100/h > sell 95/h → loss
      materials: { items: [] },
      labour: { lines: [{ estimatedHours: 1, hourlyRate: 100 }] },
    }).rollup;
    expect(negative.margin.amount).toBeLessThan(0);
    expect(negative.flag).toBe("negative");

    const low = computeQuoteMarginSections({
      // cost 85/h, sell 95/h → margin = 10/95 = 10.5% < 15% default → low
      materials: { items: [] },
      labour: { lines: [{ estimatedHours: 1, hourlyRate: 85 }] },
    }).rollup;
    expect(low.flag).toBe("low");
    expect(low.margin.amount).toBeGreaterThan(0);

    const ok = computeQuoteMarginSections({
      // cost 50/h, sell 95/h → margin = 45/95 = 47.4% → ok
      materials: { items: [] },
      labour: { lines: [{ estimatedHours: 1, hourlyRate: 50 }] },
    }).rollup;
    expect(ok.flag).toBe("ok");
  });

  it("a custom threshold moves the low boundary; negative is unaffected", () => {
    const input: QuoteMarginInput = {
      // cost 60/h, sell 95/h → margin 35/95 = 36.8%
      materials: { items: [] },
      labour: { lines: [{ estimatedHours: 1, hourlyRate: 60 }] },
    };
    // default 15% → ok
    expect(computeQuoteMarginSections(input).rollup.flag).toBe("ok");
    // raise the bar to 40% → now this 36.8% margin reads 'low'
    expect(computeQuoteMarginSections(input, { lowMarginThresholdPct: 40 }).rollup.flag).toBe("low");

    // a loss stays 'negative' regardless of how high the threshold is set
    const loss: QuoteMarginInput = { materials: { items: [] }, labour: { lines: [{ estimatedHours: 1, hourlyRate: 200 }] } };
    expect(computeQuoteMarginSections(loss, { lowMarginThresholdPct: 90 }).rollup.flag).toBe("negative");
  });

  it("the default threshold is the exported documented constant", () => {
    expect(DEFAULT_LOW_MARGIN_THRESHOLD_PCT).toBe(15);
    // a margin EXACTLY at the threshold is NOT low (boundary is `< threshold`).
    // sell 100, cost 85 → margin 15% exactly → ok.
    const atBoundary = computeQuoteMarginSections({
      pricing: { materialMarkupPct: { default: (100 / 85 - 1) * 100 } }, // sell = cost/0.85
      materials: { items: [{ quantity: 1, unitCost: 85 }] },
      labour: { lines: [] },
    }).sections.find((s) => s.section === "materials")!;
    expect(atBoundary.margin.pct).toBe(15);
    expect(atBoundary.flag).toBe("ok");
  });

  it("classifies on the UNROUNDED margin, not the displayed pct (sub-threshold near the boundary)", () => {
    // 17.58% markup on $1000 → true margin 14.9515% (< 15% → low), but round1
    // lifts the DISPLAYED pct to 15.0. The flag must read the true margin, not the
    // rounded display — otherwise [14.95%, 15.0%) margins are silently 'ok'.
    const mat = computeQuoteMarginSections({
      pricing: { materialMarkupPct: { default: 17.58 } },
      materials: { items: [{ quantity: 1, unitCost: 1000 }] },
      labour: { lines: [] },
    }).sections.find((s) => s.section === "materials")!;
    expect(mat.margin.pct).toBe(15); // displayed value rounds up
    expect(mat.flag).toBe("low"); // but the flag honours the true 14.95%
  });
});

describe("#186 internal-only boundary — single source of truth", () => {
  it("the key set is the documented, non-empty, frozen internal-only register", () => {
    expect(QUOTE_MARGIN_INTERNAL_ONLY_KEYS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(QUOTE_MARGIN_INTERNAL_ONLY_KEYS)).toBe(true);
    // The exact register — a change here is an intentional boundary change. Every
    // entry is a REAL output field name (no phantoms); the nested margin.amount /
    // margin.pct are covered wholesale by the parent `margin` key.
    expect([...QUOTE_MARGIN_INTERNAL_ONLY_KEYS]).toEqual([
      "cost",
      "totalCost",
      "margin",
      "effectiveMargin",
      "flag",
      "markupPct",
    ]);
    // sell-side fields are NOT in the set (clients legitimately see sell prices).
    for (const safe of ["sell", "sellRate", "subtotalExGst", "totalSell"]) {
      expect(QUOTE_MARGIN_INTERNAL_ONLY_KEYS as readonly string[]).not.toContain(safe);
    }
  });

  it("reverse drift-guard: every cost/margin/markup-named output key is registered", () => {
    // The #186 boundary's whole point: a NEW cost/margin field on this module's
    // output must be registered here in the same change. Walk BOTH outputs
    // recursively (overridden input so effectiveMargin populates) and assert every
    // key whose name signals cost/margin/markup is in the set — so adding an
    // unregistered one turns this test red.
    const seen = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === "object") {
        for (const [k, val] of Object.entries(v)) {
          seen.add(k);
          walk(val);
        }
      }
    };
    walk(
      computeQuoteMargin({
        materials: { items: [{ quantity: 1, unitCost: 100, category: "Cable" }] },
        labour: { lines: [{ estimatedHours: 1, hourlyRate: 60 }] },
      }),
    );
    walk(
      computeQuoteMarginSections({
        pricing: { overrideTotalExGst: 500 },
        materials: { items: [{ quantity: 1, unitCost: 100, category: "Cable" }] },
        labour: { lines: [{ estimatedHours: 1, hourlyRate: 60 }] },
      }),
    );
    const registered = new Set<string>(QUOTE_MARGIN_INTERNAL_ONLY_KEYS);
    const costMarginNamed = [...seen].filter((k) => /cost|margin|markup/i.test(k));
    const unregistered = costMarginNamed.filter((k) => !registered.has(k));
    expect(unregistered).toEqual([]);
    // Forward direction: every registered key really appears on the output.
    const missing = [...QUOTE_MARGIN_INTERNAL_ONLY_KEYS].filter((k) => !seen.has(k));
    expect(missing).toEqual([]);
  });
});
