import { describe, expect, it } from "vitest";
import { computeV2QuoteMargin } from "./quote-margin-v2";

/**
 * Sell-side margin (#214/#193): margin = (qty×rate) − (qty×unitCost) per
 * section + rollup, with uncosted-line honesty (P7 — absent cost is never $0).
 */

const q = (sections: Array<{ id?: string; title?: string; lines: Array<{ qty: number; rate: number; unitCost?: number | null }> }>) => ({
  sections,
});

describe("computeV2QuoteMargin", () => {
  it("fully-costed section → cost, sell, margin $ and %", () => {
    const m = computeV2QuoteMargin(
      q([{ id: "s1", title: "Power", lines: [{ qty: 10, rate: 25, unitCost: 15 }] }]),
    );
    const s = m.sections[0]!;
    expect(s.sell).toBe(250);
    expect(s.cost).toBe(150);
    expect(s.complete).toBe(true);
    expect(s.margin.amount).toBe(100);
    expect(s.margin.pct).toBe(40); // 100/250
    expect(s.flag).toBe("ok");
    expect(m.rollup.margin.amount).toBe(100);
  });

  it("a line with NO unitCost is uncosted — never counted as $0 cost (no fake 100%)", () => {
    const m = computeV2QuoteMargin(
      q([{ lines: [{ qty: 10, rate: 25, unitCost: 15 }, { qty: 1, rate: 100 /* no cost */ }] }]),
    );
    const s = m.sections[0]!;
    expect(s.sell).toBe(350);
    expect(s.cost).toBe(150); // only the costed line
    expect(s.costedLineCount).toBe(1);
    expect(s.uncostedLineCount).toBe(1);
    expect(s.complete).toBe(false);
    expect(s.margin.pct).toBeNull(); // incomplete → no margin % shown
    expect(s.flag).toBe("ok"); // never a green/low on incomplete data
  });

  it("a section sold below cost flags negative (loss)", () => {
    const m = computeV2QuoteMargin(q([{ lines: [{ qty: 1, rate: 50, unitCost: 80 }] }]));
    const s = m.sections[0]!;
    expect(s.margin.amount).toBe(-30);
    expect(s.flag).toBe("negative");
  });

  it("a thin positive margin flags low; default threshold is 15%", () => {
    const m = computeV2QuoteMargin(q([{ lines: [{ qty: 1, rate: 100, unitCost: 90 }] }]));
    expect(m.sections[0]!.margin.pct).toBe(10);
    expect(m.sections[0]!.flag).toBe("low");
  });

  it("the low-margin threshold is configurable (never hardcoded in the math)", () => {
    const lines = [{ qty: 1, rate: 100, unitCost: 90 }];
    expect(computeV2QuoteMargin(q([{ lines }]), { lowMarginThresholdPct: 5 }).sections[0]!.flag).toBe("ok");
  });

  it("rollup sums across sections from all lines (not the rounded section rows)", () => {
    const m = computeV2QuoteMargin(
      q([
        { lines: [{ qty: 1, rate: 100, unitCost: 60 }] },
        { lines: [{ qty: 2, rate: 50, unitCost: 30 }] },
      ]),
    );
    expect(m.rollup.sell).toBe(200);
    expect(m.rollup.cost).toBe(120);
    expect(m.rollup.margin.amount).toBe(80);
    expect(m.rollup.complete).toBe(true);
  });

  it("an empty section is complete with no margin %", () => {
    const m = computeV2QuoteMargin(q([{ lines: [] }]));
    expect(m.sections[0]!.complete).toBe(true);
    expect(m.sections[0]!.margin.pct).toBeNull();
    expect(m.sections[0]!.flag).toBe("ok");
  });

  it("zero-cost (genuinely free) line: unitCost 0 is costed (not uncosted)", () => {
    const m = computeV2QuoteMargin(q([{ lines: [{ qty: 1, rate: 100, unitCost: 0 }] }]));
    const s = m.sections[0]!;
    expect(s.complete).toBe(true);
    expect(s.cost).toBe(0);
    expect(s.margin.pct).toBe(100);
  });
});
