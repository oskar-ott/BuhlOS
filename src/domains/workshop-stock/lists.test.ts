import { describe, expect, it } from "vitest";
import { listSummary, viewList, wholesalerText } from "./lists";
import type { ListLine, StockItem } from "./schema";

const item = (id: string, over: Partial<StockItem> = {}): StockItem => ({
  id, name: `Item ${id}`, brand: null, manufacturerCode: null, supplierSku: null, supplierName: null, variant: null, colourFinish: null,
  baseUnit: "each", location: null, photoId: null, locationPhotoId: null, category: null, specs: {}, defaultPack: null,
  balanceMilli: 0, estimated: false, version: 1, metaRevision: 1, verificationStatus: "unverified", verification: null,
  lastMovementAt: null, lastCountedAt: null, lastCountedByName: null, archivedAt: null, createdAt: null, createdByName: null, updatedAt: null,
  identifiers: [], ...over,
});
const line = (id: string, over: Partial<ListLine> = {}): ListLine => ({
  id, listId: "L", itemId: null, itemName: null, itemUnit: null, itemArchived: false, text: null, quantityMilli: null, unit: null,
  gotAt: null, gotById: null, gotByName: null, movementId: null, position: 0, createdAt: null, ...over,
});

describe("a shopping list read against recorded stock", () => {
  const items = [
    item("plates", { name: "Clipsal Iconic 2 gang switch", brand: "Clipsal", manufacturerCode: "3042WE", colourFinish: "White", category: "switches", specs: { range: "Iconic", kind: "Switch", gang: "2 gang" }, balanceMilli: 10_000, location: "Shelf B, Bin 2" }),
    item("gpo", { name: "Double GPO", balanceMilli: 2_000, location: "Shelf A" }),
    item("tps", { name: "2.5mm TPS", baseUnit: "metre", balanceMilli: 0, location: "Cable bay" }),
    item("old", { name: "Old dimmer", archivedAt: "2026-10-01T00:00:00Z", balanceMilli: 5_000 }),
  ];
  const list = {
    name: "Smith reno", jobLabel: "IV3232 · Smith",
    lines: [
      line("1", { itemId: "plates", quantityMilli: 4_000 }),
      line("2", { itemId: "gpo", quantityMilli: 6_000 }),
      line("3", { itemId: "tps", quantityMilli: 50_000 }),
      line("4", { text: "Clipsal 2000 series blank plates", quantityMilli: 3_000, unit: "each" }),
      line("5", { itemId: "old", itemName: "Old dimmer", itemArchived: true }),
      line("6", { itemId: "plates", quantityMilli: 1_000, gotAt: "2026-11-01T01:00:00Z", gotById: "u", gotByName: "Sam", movementId: "m1" }),
    ],
  };
  const v = viewList(list, items);

  it("in the workshop: items with stock recorded, in SHELF order — a short one is in both sections", () => {
    expect(v.workshop.map((x) => [x.line.id, x.state])).toEqual([["2", "short"], ["1", "workshop"]]);
    expect(v.workshop[0]!.shortMilli).toBe(4_000);
  });
  it("from the wholesaler: none recorded, text lines, archived items, and the rest of a short one", () => {
    expect(v.wholesaler.map((x) => [x.line.id, x.state]).sort()).toEqual([["2", "short"], ["3", "wholesaler"], ["4", "wholesaler"], ["5", "wholesaler"]]);
    expect(v.wholesaler.find((x) => x.line.id === "5")!.detail).toBe("No longer stocked in the workshop");
    expect(v.wholesaler.find((x) => x.line.id === "3")!.unit).toBe("metre");
  });
  it("got: ticked lines, counted once", () => {
    expect(v.got.map((x) => x.line.id)).toEqual(["6"]);
    expect(v.total).toBe(6);
    expect(listSummary(v)).toBe("5 to get · 1 got");
    expect(listSummary(viewList({ lines: [] }, items))).toBe("Nothing on it yet");
  });
  it("the wholesaler text names quantities and codes, and says what we have of a short one", () => {
    const text = wholesalerText(list, v);
    expect(text.split("\n")[0]).toBe("Smith reno — IV3232 · Smith");
    expect(text).toContain("- 4 each × Double GPO (we have 2 each)");
    expect(text).toContain("- 50 m × 2.5mm TPS");
    expect(text).toContain("- 3 each × Clipsal 2000 series blank plates");
    expect(text).not.toContain("Iconic"); // enough of those in the workshop
  });
});
