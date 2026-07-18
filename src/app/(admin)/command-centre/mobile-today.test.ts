import { describe, expect, it } from "vitest";
import type { ExceptionItem } from "@/domains/exceptions/types";
import { approvalsBreakdownLabel, dailyApprovalsTotal, rankNeedsYou } from "./mobile-today";

function ex(id: string, severity: ExceptionItem["severity"], createdAt?: string): ExceptionItem {
  return {
    id,
    source: "observation",
    sourceId: id,
    title: `item ${id}`,
    severity,
    actionState: "available",
    createdAt,
  };
}

describe("dailyApprovalsTotal (hours + proof excluded from the hub-bound count)", () => {
  it("sums the /hours/approvals queues only — expenses + ITPs + materials", () => {
    expect(dailyApprovalsTotal({ expenses: 3, itps: 2, materials: 1 })).toBe(6);
    expect(dailyApprovalsTotal({ expenses: 0, itps: 0, materials: 0 })).toBe(0);
  });
});

describe("approvalsBreakdownLabel (lean reset: a dark feature leaves no label)", () => {
  const counts = { expenses: 3, itps: 2, materials: 1 };

  it("names all three sources when all are live", () => {
    expect(
      approvalsBreakdownLabel(counts, { expenses: true, itps: true, materials: true }),
    ).toBe("3 expenses · 2 ITPs · 1 materials");
  });

  it("drops dark sources from the label entirely — no '0 expenses' ghost", () => {
    expect(
      approvalsBreakdownLabel(counts, { expenses: false, itps: true, materials: false }),
    ).toBe("2 ITPs");
    expect(
      approvalsBreakdownLabel(counts, { expenses: true, itps: false, materials: true }),
    ).toBe("3 expenses · 1 materials");
  });

  it("returns null when every source is dark — the caller renders no approvals pulse/row", () => {
    expect(
      approvalsBreakdownLabel(counts, { expenses: false, itps: false, materials: false }),
    ).toBeNull();
  });
});

describe("rankNeedsYou", () => {
  it("ranks critical → warning → info, then oldest first, and keeps the full list", () => {
    const items = [
      ex("a", "info", "2026-06-26T00:00:00Z"),
      ex("b", "critical", "2026-06-26T00:00:00Z"),
      ex("c", "warning", "2026-06-20T00:00:00Z"),
      ex("d", "critical", "2026-06-25T00:00:00Z"),
    ];
    const { top } = rankNeedsYou(items, 4);
    // Both criticals first (older d before b), then warning, then info.
    expect(top.map((t) => t.id)).toEqual(["d", "b", "c", "a"]);
  });

  it("splits the loudest `limit` and reports the remainder", () => {
    const items = [ex("a", "critical"), ex("b", "warning"), ex("c", "info"), ex("d", "info"), ex("e", "info")];
    const r = rankNeedsYou(items, 4);
    expect(r.top).toHaveLength(4);
    expect(r.remaining).toBe(1);
    expect(r.all).toHaveLength(5);
  });

  it("handles fewer items than the limit (no negative remainder)", () => {
    const r = rankNeedsYou([ex("a", "critical")], 4);
    expect(r.top).toHaveLength(1);
    expect(r.remaining).toBe(0);
  });
});
