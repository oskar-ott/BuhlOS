import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
  applyPresetToLine,
  computeLabourLine,
  computeLabourTotals,
  LABOUR_CALC_DEFAULTS,
  type LabourCalcLine,
  type LabourCalcSettings,
  type RatePreset,
} from "./labour-calc";

/**
 * Parity-first coverage for the #193 pure labour calculator.
 *
 * THE LIVE ORACLE: api/quotes.js exports `computeQuoteTotals` (CJS,
 * `module.exports.computeQuoteTotals`). We require it here and run the SAME
 * labour fixtures through it, asserting our module's {hours,cost,sell,sellRate}
 * equals legacy's `.labour` block byte-for-byte. This makes parity an
 * executable contract, not a hand-derived comment.
 */
const requireFromHere = createRequire(import.meta.url);
const legacy = requireFromHere("../../../api/quotes.js") as {
  computeQuoteTotals: (sections: {
    pricing?: Record<string, unknown>;
    materials?: { items?: unknown[] };
    labour?: { lines?: unknown[] };
    provisional?: { items?: unknown[] };
  }) => {
    labour: { hours: number; cost: number; sell: number; sellRate: number };
    margin: { amount: number; pct: number };
  };
};

/** Run fixture lines through the legacy oracle's labour block. `pricing` maps
 *  our settings onto the legacy PRICING_DEFAULTS keys (same names). */
function legacyLabour(lines: LabourCalcLine[], settings: LabourCalcSettings) {
  return legacy.computeQuoteTotals({
    pricing: {
      labourSellRate: settings.labourSellRate,
      labourCostMode: settings.labourCostMode,
      labourCostRate: settings.labourCostRate,
    },
    materials: { items: [] },
    labour: { lines },
    provisional: { items: [] },
  });
}

/** Assert our totals equal the legacy oracle's labour + margin blocks. */
function expectParity(lines: LabourCalcLine[], settings: LabourCalcSettings) {
  const ours = computeLabourTotals(lines, settings);
  const oracle = legacyLabour(lines, settings);
  expect({ hours: ours.hours, cost: ours.cost, sell: ours.sell, sellRate: ours.sellRate }).toEqual({
    hours: oracle.labour.hours,
    cost: oracle.labour.cost,
    sell: oracle.labour.sell,
    sellRate: oracle.labour.sellRate,
  });
  // The legacy margin spans materials+labour; with zero materials it equals the
  // labour-only margin, so our margin block must match too.
  expect(ours.margin).toEqual({ amount: oracle.margin.amount, pct: oracle.margin.pct });
  return ours;
}

const DEFAULTS = LABOUR_CALC_DEFAULTS;

describe("computeLabourTotals — parity with legacy computeQuoteTotals", () => {
  it("per-line mode: mixed hourlyRate + null→fallback", () => {
    const lines: LabourCalcLine[] = [
      { estimatedHours: 4, crewSize: 2, hourlyRate: 80, riskFactor: 1 }, // adj 8h @80 cost / @95 sell
      { estimatedHours: 3, crewSize: 1, hourlyRate: null, riskFactor: 1 }, // adj 3h @65 fallback
    ];
    const t = expectParity(lines, DEFAULTS);
    // hand check: hours 8+3=11; cost 8*80+3*65=640+195=835; sell 11*95=1045
    expect(t).toMatchObject({ hours: 11, cost: 835, sell: 1045 });
  });

  it("shared mode forces labourCostRate for every line (ignores hourlyRate)", () => {
    const settings: LabourCalcSettings = { ...DEFAULTS, labourCostMode: "shared", labourCostRate: 70 };
    const lines: LabourCalcLine[] = [
      { estimatedHours: 5, crewSize: 1, hourlyRate: 200, riskFactor: 1 }, // hourlyRate IGNORED → 70
      { estimatedHours: 2, crewSize: 2, hourlyRate: null, riskFactor: 1 }, // adj 4h @70
    ];
    const t = expectParity(lines, settings);
    // hours 5+4=9; cost 9*70=630; sell 9*95=855
    expect(t).toMatchObject({ hours: 9, cost: 630, sell: 855 });
  });

  it("crewSize:0 coerces to 1 (legacy `|| 1`)", () => {
    const lines: LabourCalcLine[] = [{ estimatedHours: 6, crewSize: 0, hourlyRate: 60, riskFactor: 1 }];
    const t = expectParity(lines, DEFAULTS);
    // crewSize 0 → 1, so hours = 6*1 = 6; cost 6*60=360; sell 6*95=570
    expect(t).toMatchObject({ hours: 6, cost: 360, sell: 570 });
  });

  it("crewSize missing defaults to 1", () => {
    const lines: LabourCalcLine[] = [{ estimatedHours: 6, hourlyRate: 60, riskFactor: 1 }];
    const t = expectParity(lines, DEFAULTS);
    expect(t).toMatchObject({ hours: 6, cost: 360, sell: 570 });
  });

  it("riskFactor:0 coerces to 1.0 (legacy `|| 1.0`)", () => {
    const lines: LabourCalcLine[] = [{ estimatedHours: 4, crewSize: 1, hourlyRate: 50, riskFactor: 0 }];
    const t = expectParity(lines, DEFAULTS);
    // risk 0 → 1.0, so adjHours = 4; cost 4*50=200; sell 4*95=380
    expect(t).toMatchObject({ hours: 4, cost: 200, sell: 380 });
  });

  it("riskFactor is uncapped (high multiplier applies fully)", () => {
    const lines: LabourCalcLine[] = [{ estimatedHours: 2, crewSize: 1, hourlyRate: 100, riskFactor: 3 }];
    const t = expectParity(lines, DEFAULTS);
    // adjHours = 2*3 = 6; cost 6*100=600; sell 6*95=570
    expect(t).toMatchObject({ hours: 6, cost: 600, sell: 570 });
  });

  it("zero-hours line contributes nothing but is counted", () => {
    const lines: LabourCalcLine[] = [
      { estimatedHours: 0, crewSize: 2, hourlyRate: 80, riskFactor: 1 },
      { estimatedHours: 4, crewSize: 1, hourlyRate: 80, riskFactor: 1 },
    ];
    const t = expectParity(lines, DEFAULTS);
    expect(t).toMatchObject({ hours: 4, cost: 320, sell: 380 });
  });

  it("uniform sellRate applies the same client rate to every line", () => {
    const settings: LabourCalcSettings = { ...DEFAULTS, labourSellRate: 120 };
    const lines: LabourCalcLine[] = [
      { estimatedHours: 1, crewSize: 1, hourlyRate: 50, riskFactor: 1 },
      { estimatedHours: 2, crewSize: 1, hourlyRate: 90, riskFactor: 1 },
    ];
    const t = expectParity(lines, settings);
    // sell = (1+2)*120 = 360; cost = 50+180 = 230; sellRate echoed
    expect(t).toMatchObject({ sell: 360, cost: 230, sellRate: 120 });
  });

  it("empty line list → zeros and 0% margin", () => {
    const t = expectParity([], DEFAULTS);
    expect(t).toMatchObject({ hours: 0, cost: 0, sell: 0, margin: { amount: 0, pct: 0 } });
  });

  it("margin: amount = sell - cost, pct = round1((sell-cost)/sell*100)", () => {
    const lines: LabourCalcLine[] = [{ estimatedHours: 10, crewSize: 1, hourlyRate: 65, riskFactor: 1 }];
    const t = expectParity(lines, DEFAULTS);
    // cost 650, sell 950, margin amount 300, pct = 300/950*100 = 31.578... → 31.6
    expect(t.margin).toEqual({ amount: 300, pct: 31.6 });
  });
});

describe("round2 single-round-at-end parity (not per-line rounding)", () => {
  it("20 lines of 0.33h sum unrounded then round once", () => {
    const lines: LabourCalcLine[] = Array.from({ length: 20 }, () => ({
      estimatedHours: 0.33,
      crewSize: 1,
      hourlyRate: 65,
      riskFactor: 1,
    }));
    const t = expectParity(lines, DEFAULTS);
    // 20 * 0.33 = 6.6 hours exactly; cost = 6.6*65 = 429; sell = 6.6*95 = 627.
    // Per-line rounding of cost (0.33*65=21.45 → 21.45*20=429) happens to match
    // here, but the contract is: sum-unrounded-then-round. The parity assertion
    // against the legacy oracle is the real guard.
    expect(t).toMatchObject({ hours: 6.6, cost: 429, sell: 627 });
  });

  it("fractional rates that would drift if rounded per line stay in parity", () => {
    // 3 lines of 1/3-ish hours at an odd rate — exercises float accumulation.
    const lines: LabourCalcLine[] = [
      { estimatedHours: 0.333, crewSize: 1, hourlyRate: 99.99, riskFactor: 1.07 },
      { estimatedHours: 1.666, crewSize: 3, hourlyRate: 71.5, riskFactor: 0.93 },
      { estimatedHours: 2.5, crewSize: 1, hourlyRate: null, riskFactor: 1.0 },
    ];
    // No hand numbers: the legacy oracle is the source of truth here.
    expectParity(lines, DEFAULTS);
  });

  it("margin parity holds when raw totals carry sub-cent fractions (round-once regression)", () => {
    // Regression for the margin rounding-order bug: these lines produce raw
    // cost 801.5625 and raw sell 876.375. Legacy differences the UNROUNDED
    // totals → margin.amount = round2(876.375 - 801.5625) = 74.81. Computing it
    // from the rounded totals would give round2(876.38 - 801.56) = 74.82 — a
    // one-cent break. expectParity asserts ours.margin === the legacy oracle,
    // so this fixture fails if the margin is ever derived from rounded totals.
    const lines: LabourCalcLine[] = [
      { estimatedHours: 1.5, crewSize: 1, hourlyRate: 95, riskFactor: 0.9 },
      { estimatedHours: 2.5, crewSize: 3, hourlyRate: 85.5, riskFactor: 1.05 },
    ];
    const t = expectParity(lines, DEFAULTS);
    expect(t.margin.amount).toBe(74.81);
  });
});

describe("unpriced — additive honesty, never changes a number", () => {
  it("with standard defaults no line is unpriced (byte-identical to legacy)", () => {
    const lines: LabourCalcLine[] = [
      { estimatedHours: 4, crewSize: 1, hourlyRate: null, riskFactor: 1 }, // falls back to 65
      { estimatedHours: 2, crewSize: 1, hourlyRate: 80, riskFactor: 1 },
    ];
    const t = expectParity(lines, DEFAULTS);
    expect(t.unpricedCount).toBe(0);
  });

  it("null labourCostRate + null hourlyRate → unpriced:true, 0 cost, still flagged", () => {
    const settings: LabourCalcSettings = {
      labourSellRate: 95,
      labourCostMode: "per-line",
      labourCostRate: null, // no usable fallback
    };
    const line: LabourCalcLine = { estimatedHours: 4, crewSize: 1, hourlyRate: null, riskFactor: 1 };
    const r = computeLabourLine(line, settings);
    expect(r.unpriced).toBe(true);
    expect(r.cost).toBe(0); // contributes nothing, never a faked $0 with a finite rate
    expect(r.sell).toBe(380); // sell still computed from labourSellRate

    const t = computeLabourTotals([line], settings);
    expect(t.unpricedCount).toBe(1);
    expect(t.cost).toBe(0);
    expect(t.sell).toBe(380);

    // PARITY: legacy's isFinite(costRate) gate also contributes 0 cost here, so
    // the NUMBERS still match the oracle — only the flag is added.
    const oracle = legacyLabour([line], settings);
    expect(oracle.labour.cost).toBe(0);
    expect(oracle.labour.sell).toBe(380);
  });

  it("a priced line alongside an unpriced one keeps the priced cost intact", () => {
    const settings: LabourCalcSettings = {
      labourSellRate: 95,
      labourCostMode: "per-line",
      labourCostRate: null,
    };
    const lines: LabourCalcLine[] = [
      { estimatedHours: 2, crewSize: 1, hourlyRate: 80, riskFactor: 1 }, // priced → cost 160
      { estimatedHours: 4, crewSize: 1, hourlyRate: null, riskFactor: 1 }, // unpriced → 0 cost
    ];
    const t = computeLabourTotals(lines, settings);
    expect(t.cost).toBe(160);
    expect(t.unpricedCount).toBe(1);
    expect(t.sell).toBe((2 + 4) * 95);
    // still in lockstep with the legacy oracle
    const oracle = legacyLabour(lines, settings);
    expect(t.cost).toBe(oracle.labour.cost);
    expect(t.sell).toBe(oracle.labour.sell);
  });
});

describe("computeLabourLine — per-line display result", () => {
  it("returns rounded display values + resolved rates", () => {
    const r = computeLabourLine({ estimatedHours: 3, crewSize: 2, hourlyRate: 70, riskFactor: 1.1 });
    // adjHours = 3*2*1.1 = 6.6; cost = 6.6*70 = 462; sell = 6.6*95 = 627
    expect(r).toMatchObject({ hours: 6.6, costRate: 70, sellRate: 95, cost: 462, sell: 627, unpriced: false });
  });

  it("shared mode resolves the shared cost rate", () => {
    const r = computeLabourLine(
      { estimatedHours: 2, crewSize: 1, hourlyRate: 999, riskFactor: 1 },
      { ...DEFAULTS, labourCostMode: "shared", labourCostRate: 60 },
    );
    expect(r.costRate).toBe(60);
    expect(r.cost).toBe(120);
  });
});

describe("rate presets — snapshot-on-use independence", () => {
  function preset(over: Partial<RatePreset> = {}): RatePreset {
    return { id: "qrp_aaaa1111", name: "Standard sparky", loadedCostRate: 72, sellRate: 110, archived: false, ...over };
  }

  it("applyPresetToLine copies the cost rate onto hourlyRate + stamps snapshot id/name", () => {
    const p = preset();
    const base: LabourCalcLine = { estimatedHours: 4, crewSize: 1, riskFactor: 1 };
    const applied = applyPresetToLine(base, p);
    expect(applied.hourlyRate).toBe(72);
    expect(applied.ratePresetId).toBe("qrp_aaaa1111");
    expect(applied.ratePresetName).toBe("Standard sparky");
    // the preset's sellRate is NOT written onto the line (parity: sell from settings)
    expect("sellRateOverride" in applied).toBe(false);
  });

  it("the applied line computes using the snapshot rate (cost side), sell from settings", () => {
    const applied = applyPresetToLine({ estimatedHours: 5, crewSize: 1, riskFactor: 1 }, preset());
    const r = computeLabourLine(applied, DEFAULTS);
    // cost = 5 * 72 (snapshot) = 360; sell = 5 * 95 (settings, NOT preset.sellRate 110)
    expect(r.cost).toBe(360);
    expect(r.sell).toBe(475);
  });

  it("editing the preset object AFTER apply does NOT change the applied line's total", () => {
    const p = preset({ loadedCostRate: 72 });
    const base: LabourCalcLine = { estimatedHours: 5, crewSize: 1, riskFactor: 1 };
    const applied = applyPresetToLine(base, p);
    const before = computeLabourTotals([applied], DEFAULTS).cost;

    // mutate the preset (simulating an admin editing it later)
    p.loadedCostRate = 999;
    p.name = "Renamed";

    const after = computeLabourTotals([applied], DEFAULTS).cost;
    expect(after).toBe(before); // independence — rate was copied at apply time
    expect(before).toBe(360);
    expect(applied.ratePresetName).toBe("Standard sparky"); // snapshot name unchanged
  });
});
