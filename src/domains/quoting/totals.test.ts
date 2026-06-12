import { describe, expect, it } from "vitest";
import {
  GST_RATE,
  computeQuoteTotals,
  formatMoney,
  lineTotal,
  roundMoney,
  sectionSubtotal,
} from "./totals";

/**
 * Golden fixtures for the foundation totals (#183).
 *
 * MIRROR WARNING: the GOLDEN quote below is duplicated by value in
 * src/domains/quoting/quotes-v2-api.test.ts (the CJS server mirror cannot
 * import this module). If a number changes here, change it there in the
 * same commit — the two tests existing is what stops the TS builder math
 * and the JS server math drifting apart.
 */

const GOLDEN_SECTIONS = [
  {
    lines: [
      { qty: 3, rate: 99.95 }, // 299.85
      { qty: 0.5, rate: 150 }, // 75.00
    ],
  },
  {
    lines: [
      { qty: 10, rate: 0.333 }, // 3.33 — rounded AT THE LINE
    ],
  },
];
const GOLDEN = {
  subtotalExGst: 378.18,
  gst: 37.82, // 378.18 × 0.1 = 37.818 → 37.82
  totalIncGst: 416.0,
  lineCount: 3,
};

describe("roundMoney", () => {
  it("rounds to cents, half-up toward +∞, surviving float artefacts", () => {
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(2.675)).toBe(2.68); // 2.675*100 = 267.49999… without the nudge
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(-1.005)).toBe(-1); // toward +∞ on the half-cent
    expect(roundMoney(0)).toBe(0);
    expect(roundMoney(416)).toBe(416);
  });
});

describe("lineTotal (computed, never stored)", () => {
  it("is qty × rate rounded to cents", () => {
    expect(lineTotal({ qty: 3, rate: 99.95 })).toBe(299.85);
    expect(lineTotal({ qty: 10, rate: 0.333 })).toBe(3.33);
    expect(lineTotal({ qty: 0, rate: 500 })).toBe(0);
  });

  it("supports negative rates (discount lines)", () => {
    expect(lineTotal({ qty: 1, rate: -50 })).toBe(-50);
  });
});

describe("computeQuoteTotals — golden fixtures", () => {
  it("matches the golden quote exactly", () => {
    expect(computeQuoteTotals(GOLDEN_SECTIONS)).toEqual(GOLDEN);
  });

  it("rounds at the line THEN sums (the pinned rule)", () => {
    // Three 0.005 line totals: each rounds to 0.01 → 0.03.
    // Round-at-sum would give round(0.015) = 0.02 — the rule is observable.
    const sections = [
      {
        lines: [
          { qty: 1, rate: 0.005 },
          { qty: 1, rate: 0.005 },
          { qty: 1, rate: 0.005 },
        ],
      },
    ];
    const t = computeQuoteTotals(sections);
    expect(t.subtotalExGst).toBe(0.03);
    expect(t.gst).toBe(0); // 0.003 → 0.00
    expect(t.totalIncGst).toBe(0.03);
  });

  it("absorbs float drift when summing rounded line totals", () => {
    const sections = [
      {
        lines: [
          { qty: 0.1, rate: 1 },
          { qty: 0.2, rate: 1 },
        ],
      },
    ];
    expect(computeQuoteTotals(sections).subtotalExGst).toBe(0.3);
  });

  it("returns zeros for an empty quote (and for empty sections)", () => {
    expect(computeQuoteTotals([])).toEqual({
      subtotalExGst: 0,
      gst: 0,
      totalIncGst: 0,
      lineCount: 0,
    });
    expect(computeQuoteTotals([{ lines: [] }]).lineCount).toBe(0);
  });

  it("nets discount lines into the subtotal", () => {
    const sections = [
      {
        lines: [
          { qty: 2, rate: 100 }, // 200
          { qty: 1, rate: -50 }, // -50
        ],
      },
    ];
    expect(computeQuoteTotals(sections)).toEqual({
      subtotalExGst: 150,
      gst: 15,
      totalIncGst: 165,
      lineCount: 2,
    });
  });

  it("GST rate is a configurable constant, not hardcoded math", () => {
    expect(GST_RATE).toBe(0.1);
    const zeroGst = computeQuoteTotals(GOLDEN_SECTIONS, 0);
    expect(zeroGst.gst).toBe(0);
    expect(zeroGst.totalIncGst).toBe(zeroGst.subtotalExGst);
  });
});

describe("sectionSubtotal", () => {
  it("sums one section's rounded line totals", () => {
    expect(sectionSubtotal(GOLDEN_SECTIONS[0]!)).toBe(374.85);
    expect(sectionSubtotal({ lines: [] })).toBe(0);
  });
});

describe("formatMoney", () => {
  it("prints en-AU money with grouping and forced cents", () => {
    expect(formatMoney(1234.5)).toBe("$1,234.50");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(-10)).toBe("−$10.00");
    expect(formatMoney(416)).toBe("$416.00");
  });
});
