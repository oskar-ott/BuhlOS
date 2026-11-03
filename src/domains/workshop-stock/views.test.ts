import { describe, expect, it } from "vitest";
import { ALL_ITEMS_LABEL, groupItems, isGroupBy, isSort, isView, noneRecorded, sortItems } from "./views";
import { NOT_SORTED_LABEL } from "./types";
import { NO_SHELF_LABEL } from "./location";

const items = [
  { name: "TPS 2.5mm", location: "Cable bay", category: "cable" },
  { name: "Double GPO", location: "Shelf A2, Bin 4", category: "switches" },
  { name: "Cable ties", location: null, category: null },
  { name: "Single switch", location: "shelf a2 / Bin 5", category: "switches" },
  { name: "Mystery", location: "Rack C", category: "not_a_real_type" },
];

describe("groupItems", () => {
  it("by shelf: shelves in natural order, unlocated last", () => {
    const g = groupItems(items, "shelf");
    expect(g.map((x) => x.label)).toEqual(["Cable bay", "Rack C", "Shelf A2", NO_SHELF_LABEL]);
    expect(g[2]!.items.map((i) => i.name)).toEqual(["Double GPO", "Single switch"]);
  });

  it("by type: catalogue order, unknown keys read as Other, not sorted last", () => {
    const g = groupItems(items, "type");
    expect(g.map((x) => x.label)).toEqual(["Switches & GPOs", "Cable", "Other", NOT_SORTED_LABEL]);
    expect(g[0]!.items.map((i) => i.name)).toEqual(["Double GPO", "Single switch"]);
  });

  it("none: one group A–Z, and nothing for an empty list", () => {
    const g = groupItems(items, "none");
    expect(g).toHaveLength(1);
    expect(g[0]!.label).toBe(ALL_ITEMS_LABEL);
    expect(g[0]!.items.map((i) => i.name)).toEqual(["Cable ties", "Double GPO", "Mystery", "Single switch", "TPS 2.5mm"]);
    expect(groupItems([], "none")).toEqual([]);
  });

  it("every item lands in exactly one group, whichever grouping", () => {
    for (const by of ["shelf", "type", "none"] as const) {
      expect(groupItems(items, by).flatMap((g) => g.items)).toHaveLength(items.length);
    }
  });
});

describe("guards", () => {
  it("accept only known views and groupings (a stale saved choice falls back)", () => {
    expect(isView("cards")).toBe(true);
    expect(isView("kanban")).toBe(false);
    expect(isGroupBy("type")).toBe(true);
    expect(isGroupBy(null)).toBe(false);
  });
});

describe("sortItems", () => {
  const day = (d: number) => new Date(Date.UTC(2026, 10, d)).toISOString();
  const rows = [
    { name: "Bravo", balanceMilli: 5000, lastMovementAt: day(2), lastCountedAt: day(1) },
    { name: "alpha", balanceMilli: 0, lastMovementAt: null, lastCountedAt: null },
    { name: "Charlie", balanceMilli: 5000, lastMovementAt: day(3), lastCountedAt: day(2) },
  ];
  const names = (s: Parameters<typeof sortItems>[1]) => sortItems(rows, s).map((r) => r.name);

  it("name: A–Z ignoring case; reversed Z–A", () => {
    expect(names({ key: "name", reversed: false })).toEqual(["alpha", "Bravo", "Charlie"]);
    expect(names({ key: "name", reversed: true })).toEqual(["Charlie", "Bravo", "alpha"]);
  });
  it("recorded: lowest first, ties by name", () => {
    expect(names({ key: "recorded", reversed: false })).toEqual(["alpha", "Bravo", "Charlie"]);
    expect(names({ key: "recorded", reversed: true })).toEqual(["Bravo", "Charlie", "alpha"]);
  });
  it("moved: newest first, never moved last", () => {
    expect(names({ key: "moved", reversed: false })).toEqual(["Charlie", "Bravo", "alpha"]);
  });
  it("counted: never counted first, then the oldest count", () => {
    expect(names({ key: "counted", reversed: false })).toEqual(["alpha", "Bravo", "Charlie"]);
  });
  it("leaves the input alone", () => {
    sortItems(rows, { key: "recorded", reversed: true });
    expect(rows.map((r) => r.name)).toEqual(["Bravo", "alpha", "Charlie"]);
  });
  it("isSort rejects a stale saved choice", () => {
    expect(isSort({ key: "counted", reversed: false })).toBe(true);
    expect(isSort({ key: "price", reversed: false })).toBe(false);
    expect(isSort(null)).toBe(false);
  });
  it("noneRecorded counts only zero balances", () => {
    expect(noneRecorded(rows)).toBe(1);
  });
});
