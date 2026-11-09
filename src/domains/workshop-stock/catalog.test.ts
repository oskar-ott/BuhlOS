import { describe, expect, it } from "vitest";
import { cardLocation, cardSpecLine, isCatalogSort, sortCatalog } from "./catalog";

const item = (
  name: string,
  o: Partial<{
    location: string | null;
    lastMovementAt: string | null;
    createdAt: string | null;
  }> = {}
) => ({
  name,
  location: o.location ?? null,
  lastMovementAt: o.lastMovementAt ?? null,
  createdAt: o.createdAt ?? null,
});

describe("sortCatalog", () => {
  const items = [
    item("Switch 10", {
      location: "Shelf A10",
      lastMovementAt: "2026-11-01T00:00:00Z",
      createdAt: "2026-10-01T00:00:00Z",
    }),
    item("switch 2", {
      location: "Shelf A2",
      lastMovementAt: null,
      createdAt: "2026-11-02T00:00:00Z",
    }),
    item("Cable", { location: null, lastMovementAt: "2026-11-05T00:00:00Z", createdAt: null }),
  ];

  it("name: natural, case-insensitive", () => {
    expect(sortCatalog(items, "name").map((i) => i.name)).toEqual([
      "Cable",
      "switch 2",
      "Switch 10",
    ]);
  });
  it("shelf: natural location order, the unlocated last", () => {
    expect(sortCatalog(items, "shelf").map((i) => i.name)).toEqual([
      "switch 2",
      "Switch 10",
      "Cable",
    ]);
  });
  it("moved: newest first, never-moved last", () => {
    expect(sortCatalog(items, "moved").map((i) => i.name)).toEqual([
      "Cable",
      "Switch 10",
      "switch 2",
    ]);
  });
  it("added: newest first, unknown last", () => {
    expect(sortCatalog(items, "added").map((i) => i.name)).toEqual([
      "switch 2",
      "Switch 10",
      "Cable",
    ]);
  });
  it("never changes the input", () => {
    const copy = [...items];
    sortCatalog(items, "name");
    expect(items).toEqual(copy);
  });
  it("knows its sorts", () => {
    expect(isCatalogSort("moved")).toBe(true);
    expect(isCatalogSort("price")).toBe(false);
  });
});

describe("card lines", () => {
  it("drops the brand the card already shows", () => {
    expect(
      cardSpecLine({
        brand: "Clipsal",
        manufacturerCode: "2025WE",
        colourFinish: "White",
        variant: "10A",
      })
    ).toBe("2025WE · White · 10A");
    expect(
      cardSpecLine({ brand: null, manufacturerCode: null, colourFinish: null, variant: null })
    ).toBe("");
  });
  it("shelf and bin, or the shelf alone, or nothing", () => {
    expect(cardLocation("Shelf A2, Bin 4")).toBe("Shelf A2 · Bin 4");
    expect(cardLocation("Cable bay")).toBe("Cable bay");
    expect(cardLocation("  ")).toBeNull();
  });
});
