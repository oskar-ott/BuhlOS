import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { computeQuoteContingency } from "./contingency";
import type { QuoteMarginInput } from "./margin";

/**
 * #223 — deliberate contingency breakout. The % path reuses computeQuoteMargin
 * (byte-parity with legacy), so we assert against the LIVE legacy oracle
 * (api/quotes.js computeQuoteTotals): the breakout amount === legacy
 * contingency.amount, and base + amount === legacy subtotalExGst on clean bases.
 */
const requireFromHere = createRequire(import.meta.url);
const legacy = requireFromHere("../../../api/quotes.js") as {
  computeQuoteTotals: (input: QuoteMarginInput) => {
    contingency: { pct: number; amount: number };
    subtotalExGst: number;
    overridden: boolean;
  };
};

// Clean-base fixture: materials 250 sell + labour 380 sell + PS 100 = 730 base.
const PRICING = {
  materialMarkupPct: { default: 0 }, // keep cost==sell so the base is exact
  labourSellRate: 95,
  labourCostMode: "per-line" as const,
  labourCostRate: 65,
  gstPct: 10,
  overrideTotalExGst: null,
};
function quote(over: Partial<QuoteMarginInput["pricing"]> = {}): QuoteMarginInput {
  return {
    pricing: { ...PRICING, ...over },
    materials: { items: [{ quantity: 10, unitCost: 25, category: "Cable" }] }, // 250
    labour: { lines: [{ estimatedHours: 4, crewSize: 1, riskFactor: 1 }] }, // 4×95 = 380
    provisional: { items: [{ amountExGst: 100 }] }, // 100
  };
}

describe("computeQuoteContingency — percent (legacy-native, parity)", () => {
  it("base is sell incl. provisional, before contingency", () => {
    const c = computeQuoteContingency(quote({ contingencyPct: 0 }));
    expect(c.base).toBe(730);
    expect(c.mode).toBe("percent");
    expect(c.amount).toBe(0);
    expect(c.subtotalWithContingency).toBe(730);
  });

  it("amount === legacy contingency.amount; base+amount === legacy subtotalExGst", () => {
    const input = quote({ contingencyPct: 10 });
    const c = computeQuoteContingency(input);
    const oracle = legacy.computeQuoteTotals(input);
    expect(c.pct).toBe(10);
    expect(c.amount).toBe(oracle.contingency.amount); // 73
    expect(c.subtotalWithContingency).toBe(oracle.subtotalExGst); // 803 (foots + parity)
  });

  it("flags a fixed-price override (contingency becomes informational)", () => {
    const c = computeQuoteContingency(quote({ contingencyPct: 10, overrideTotalExGst: 999 }));
    expect(c.overriddenByFixedPrice).toBe(true);
    // the amount is still the computed contingency (informational), base unchanged
    expect(c.amount).toBe(73);
  });
});

describe("computeQuoteContingency — deliberate fixed $ (new)", () => {
  it("uses the $ amount with an informational effective %", () => {
    const c = computeQuoteContingency(quote({ contingencyPct: 0 }), { amountExGst: 100 });
    expect(c.mode).toBe("amount");
    expect(c.base).toBe(730);
    expect(c.amount).toBe(100);
    expect(c.pct).toBe(13.7); // round1(100/730*100)
    expect(c.subtotalWithContingency).toBe(830);
  });

  it("a fixed $ overrides the quote's % (deliberate choice)", () => {
    // quote says 10% (=73) but the office sets a deliberate $50 instead
    const c = computeQuoteContingency(quote({ contingencyPct: 10 }), { amountExGst: 50 });
    expect(c.amount).toBe(50);
    expect(c.subtotalWithContingency).toBe(780);
  });

  it("zero base → 0% effective (no divide-by-zero)", () => {
    const empty: QuoteMarginInput = { pricing: PRICING, materials: { items: [] }, labour: { lines: [] }, provisional: { items: [] } };
    const c = computeQuoteContingency(empty, { amountExGst: 50 });
    expect(c.base).toBe(0);
    expect(c.pct).toBe(0);
    expect(c.amount).toBe(50);
  });
});
