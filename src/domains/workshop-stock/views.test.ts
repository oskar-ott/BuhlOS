import { describe, expect, it } from "vitest";
import { ALL_ITEMS_LABEL, groupItems, isGroupBy, isView } from "./views";
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
