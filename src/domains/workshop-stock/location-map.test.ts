import { describe, expect, it } from "vitest";
import { placementIssues, shelfMap, suggestBin, type MapItem } from "./location-map";
import { binAt, locationText, shelfLabel, type LocationMatrix } from "./location-matrix";

const matrix: LocationMatrix = {
  racks: [{ id: "a", name: "1", shelves: 2, bins: 3 }, { id: "c", name: "3", shelves: 2, bins: 3 }],
  rules: [{ id: "1", words: "iconic switch", rackId: "c", shelf: 2, bin: 3 }],
};

function item(id: string, name: string, location: string | null, extra: Partial<MapItem> = {}): MapItem {
  return { id, name, location, brand: null, variant: null, colourFinish: null, manufacturerCode: null, archivedAt: null, category: null, ...extra };
}

describe("binAt", () => {
  it("reads back what locationText writes, whatever the case", () => {
    expect(binAt("Rack 3 Shelf B, Bin 3", matrix)).toMatchObject({ rack: { id: "c" }, shelf: 2, bin: 3 });
    expect(binAt("rack 3 shelf b, bin 3", matrix)?.bin).toBe(3);
  });

  it("letters the shelves, and a rack can still be named anything", () => {
    expect([shelfLabel(1), shelfLabel(2), shelfLabel(26)]).toEqual(["A", "B", "Z"]);
    const lettered: LocationMatrix = { racks: [{ id: "x", name: "C", shelves: 26, bins: 2 }, { id: "bay", name: "Cable bay", shelves: 1, bins: 2 }], rules: [] };
    expect(locationText(lettered.racks[0]!, 26, 2)).toBe("Rack C Shelf Z, Bin 2");
    expect(binAt("Rack C Shelf Z, Bin 2", lettered)).toMatchObject({ rack: { id: "x" }, shelf: 26, bin: 2 });
    expect(binAt("Cable bay Shelf A, Bin 1", lettered)).toMatchObject({ rack: { id: "bay" }, shelf: 1, bin: 1 });
  });

  it("anything else isn't a bin", () => {
    expect(binAt("Shelf A2, Bin 4", matrix)).toBeNull();
    expect(binAt("Rack 3 Shelf 2, Bin 1", matrix)).toBeNull();
    expect(binAt("Rack 3 Shelf C, Bin 1", matrix)).toBeNull();
    expect(binAt("Rack 3 Shelf A, Bin 4", matrix)).toBeNull();
    expect(binAt("Rack 9 Shelf A, Bin 1", matrix)).toBeNull();
    expect(binAt(null, matrix)).toBeNull();
    expect(binAt("Rack 3 Shelf A, Bin 1", null)).toBeNull();
  });
});

describe("shelfMap", () => {
  it("sorts stock into bins, not-a-bin and nowhere, leaving out archived", () => {
    const map = shelfMap([
      item("1", "In a bin", "Rack 1 Shelf A, Bin 1"),
      item("2", "Also there", "rack 1 shelf a, bin 1"),
      item("3", "Old text", "Shelf A2"),
      item("4", "Nowhere", null),
      item("5", "Gone", "Rack 1 Shelf A, Bin 2", { archivedAt: "2026-01-01" }),
    ], matrix);
    expect(map.bins.get("a:1:1")?.map((i) => i.id)).toEqual(["1", "2"]);
    expect(map.bins.has("a:1:2")).toBe(false);
    expect(map.loose.map((i) => i.id)).toEqual(["3"]);
    expect(map.unplaced.map((i) => i.id)).toEqual(["4"]);
  });
});

describe("suggestBin", () => {
  it("a rule comes first, even with the bin in use", () => {
    const s = suggestBin({ text: "Clipsal iconic 1 gang switch" }, matrix, [item("1", "Other", "Rack 3 Shelf B, Bin 3")]);
    expect(s).toMatchObject({ location: "Rack 3 Shelf B, Bin 3", why: "Rule: “iconic switch” goes here" });
  });

  it("then the free bin closest to stock of the same type", () => {
    const items = [item("1", "A", "Rack 3 Shelf A, Bin 2", { category: "switches" }), item("2", "B", "Rack 1 Shelf A, Bin 1", { category: "cable" })];
    const s = suggestBin({ text: "Saturn dimmer", category: "switches" }, matrix, items);
    expect(s?.location).toBe("Rack 3 Shelf A, Bin 1");
    expect(s?.why).toContain("1 already on Rack 3 Shelf A");
  });

  it("then the same brand, then the first free bin", () => {
    const items = [item("1", "A", "Rack 3 Shelf A, Bin 1", { brand: "Clipsal" })];
    expect(suggestBin({ text: "thing", brand: "clipsal" }, matrix, items)?.location).toBe("Rack 3 Shelf A, Bin 2");
    expect(suggestBin({ text: "thing", brand: "Hager" }, matrix, items)).toMatchObject({ location: "Rack 1 Shelf A, Bin 1", why: "First free bin" });
  });

  it("a full shelf sends it to the closest shelf on that rack", () => {
    const items = [1, 2, 3].map((b) => item(`b${b}`, "Clipsal", `Rack 1 Shelf A, Bin ${b}`, { brand: "Clipsal" }));
    const s = suggestBin({ text: "thing", brand: "Clipsal" }, matrix, items);
    expect(s?.location).toBe("Rack 1 Shelf B, Bin 1");
    expect(s?.why).toContain("full");
  });

  it("never offers a bin another rule holds, or one that's taken, and gives up when none is free", () => {
    const small: LocationMatrix = { racks: [{ id: "a", name: "1", shelves: 1, bins: 2 }], rules: [{ id: "1", words: "fuse", rackId: "a", shelf: 1, bin: 1 }] };
    expect(suggestBin({ text: "thing" }, small, [])?.location).toBe("Rack 1 Shelf A, Bin 2");
    expect(suggestBin({ text: "thing" }, small, [item("1", "x", "Rack 1 Shelf A, Bin 2")])).toBeNull();
    expect(suggestBin({ text: "thing" }, { racks: [], rules: [] }, [])).toBeNull();
    expect(suggestBin({ text: "thing" }, null, [])).toBeNull();
  });

  it("an item being re-placed doesn't hold its own bin", () => {
    expect(suggestBin({ id: "1", text: "thing" }, matrix, [item("1", "x", "Rack 1 Shelf A, Bin 1")])?.location).toBe("Rack 1 Shelf A, Bin 1");
  });
});

describe("placementIssues", () => {
  it("lists no location, not a bin, and against its rule, and leaves correct stock alone", () => {
    const issues = placementIssues([
      item("1", "Conduit", null),
      item("2", "Saddles", "Shelf A2"),
      item("3", "Iconic switch", "Rack 1 Shelf A, Bin 1"),
      item("4", "Iconic switch 2 gang", "Rack 3 Shelf B, Bin 3"),
      item("5", "Cable", "Rack 1 Shelf B, Bin 2"),
    ], matrix);
    expect(issues.map((i) => i.item.id)).toEqual(["1", "2", "3"]);
    expect(issues[0]?.problem).toBe("No location recorded");
    expect(issues[1]?.problem).toContain("isn't a bin");
    expect(issues[2]?.suggestion?.location).toBe("Rack 3 Shelf B, Bin 3");
  });

  it("says nothing until there's a rack to compare with", () => {
    expect(placementIssues([item("1", "Conduit", null)], { racks: [], rules: [] })).toEqual([]);
  });
});
