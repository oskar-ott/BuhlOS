import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * "Exactly how much cable" (owner pull 2026-09-24): a line's quantity, unit
 * and description become a measure — metres for lengths, pieces for packs —
 * with the working shown; products roll up per category, credit notes
 * negative, unmeasured lines named rather than guessed.
 */
const requireFromHere = createRequire(import.meta.url);
const m = requireFromHere("../../../api/_lib/invoices/measure.js");

describe("measureOf", () => {
  it("rolls, drums and boxes with a printed length become metres; sold-by-the-metre stays metres", () => {
    expect(m.measureOf("CBL2.5T 2.5MM TWIN & EARTH TPS 100M ROLL", 3, "roll")).toEqual({ amount: 300, unit: "m", explain: "3 × 100 m" });
    expect(m.measureOf("2.5mm TPS cable 100m", 10, null)).toEqual({ amount: 1000, unit: "m", explain: "10 × 100 m" });
    expect(m.measureOf("Cat6 UTP 305m box", 1, "box")).toEqual({ amount: 305, unit: "m", explain: "1 × 305 m" });
    expect(m.measureOf("4MM BUILDING WIRE RED", 50, "m")).toEqual({ amount: 50, unit: "m", explain: null });
    expect(m.measureOf("4mm twin 2.5 mtr lengths", 4, "len")).toEqual({ amount: 10, unit: "m", explain: "4 × 2.5 m" });
  });
  it("packs become pieces; a millimetre size or a dimension is never a length or a pack", () => {
    expect(m.measureOf("CABLE TIES 200MM BLACK PK100", 5, "pk")).toEqual({ amount: 500, unit: "pcs", explain: "5 × 100" });
    expect(m.measureOf("Dynabolt 10x75 Box 50", 1, null)).toEqual({ amount: 50, unit: "pcs", explain: "1 × 50" });
    expect(m.measureOf("Screws 8g x 25mm x100", 2, "pk")).toEqual({ amount: 200, unit: "pcs", explain: "2 × 100" });
    expect(m.measureOf("9W LED DOWNLIGHT 90MM CUTOUT", 12, "ea")).toEqual({ amount: 12, unit: "pcs", explain: null });
  });
  it("no quantity → no measure; an unknown unit is passed through as-is", () => {
    expect(m.measureOf("Freight", null, "ea")).toEqual({ amount: null, unit: null, explain: null });
    expect(m.measureOf("Silicone", 2, "tube")).toEqual({ amount: 2, unit: "pcs", explain: null });
    expect(m.measureOf("Paint", 2, "lt")).toEqual({ amount: 2, unit: "lt", explain: null });
  });
});

describe("rollUpProducts + measureTotals", () => {
  const line = (over: Record<string, unknown>) => ({
    id: String(Math.random()), invoiceId: "i1", description: "2.5MM TPS 100M ROLL", descriptionKey: "2 5mm tps 100m roll", supplierName: "WW",
    quantity: 3, unit: "roll", signedCents: 26850, measure: { amount: 300, unit: "m", explain: "3 × 100 m" }, ...over,
  });
  it("groups the same product from the same supplier, sums cost, quantities and measures, counts invoices, credit notes negative", () => {
    const lines = [
      line({ invoiceId: "i1" }),
      line({ invoiceId: "i2", quantity: 1, signedCents: 8950, measure: { amount: 100, unit: "m", explain: "1 × 100 m" } }),
      line({ invoiceId: "cn", quantity: 1, signedCents: -8950, measure: { amount: 100, unit: "m", explain: "1 × 100 m" } }),
      line({ invoiceId: "i1", description: "4MM BUILDING WIRE RED", descriptionKey: "4mm building wire red", quantity: 50, unit: "m", signedCents: 6000, measure: { amount: 50, unit: "m", explain: null } }),
      line({ invoiceId: "i1", description: "Mystery cable", descriptionKey: "mystery cable", supplierName: "Other Co", quantity: null, unit: null, signedCents: 1000, measure: { amount: null, unit: null, explain: null } }),
    ];
    const products = m.rollUpProducts(lines);
    expect(products.map((p: { description: string; cents: number; invoiceCount: number; quantities: unknown; measures: unknown }) => [p.description, p.cents, p.invoiceCount, p.quantities, p.measures])).toEqual([
      ["2.5MM TPS 100M ROLL", 26850, 3, { roll: 3 }, { m: 300 }],
      ["4MM BUILDING WIRE RED", 6000, 1, { m: 50 }, { m: 50 }],
      ["Mystery cable", 1000, 1, {}, {}],
    ]);
    expect(m.measureTotals(lines)).toEqual({ totals: { m: 350 }, measuredLines: 4, unmeasuredLines: 1 });
  });
});
