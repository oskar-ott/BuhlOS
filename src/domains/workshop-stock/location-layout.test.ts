import { describe, expect, it } from "vitest";
import { binAt, binKey, locationText, ruleFor, type LocationMatrix } from "./location-matrix";
import { layoutGroupFor, recommendLayout } from "./location-layout";
import type { MapItem } from "./location-map";

type Item = MapItem & { specs?: Record<string, string> };

function item(id: string, name: string, extra: Partial<Item> = {}): Item {
  return { id, name, location: null, brand: null, variant: null, colourFinish: null, manufacturerCode: null, archivedAt: null, category: null, ...extra };
}

const racks = (...sizes: Array<[string, number, number]>): LocationMatrix => ({ racks: sizes.map(([name, shelves, bins]) => ({ id: name.toLowerCase(), name, shelves, bins })), rules: [] });

/** Walking distance along a shelf or straight up/down, in bins. */
function apart(a: string, b: string, matrix: LocationMatrix): number {
  const x = binAt(a, matrix)!;
  const y = binAt(b, matrix)!;
  if (x.rack.id !== y.rack.id) return Infinity;
  return Math.abs(x.shelf - y.shelf) + Math.abs(x.bin - y.bin);
}

function placed(names: string[], matrix: LocationMatrix) {
  const plan = recommendLayout(names.map((n, i) => item(String(i), n)), matrix, { keepRules: true })!;
  const proposed: LocationMatrix = { racks: matrix.racks, rules: [...plan.kept, ...plan.rules.map((r, i) => ({ ...r, id: String(i) }))] };
  return { plan, at: (text: string) => ruleFor(text, proposed)?.location ?? null };
}

describe("layoutGroupFor", () => {
  it.each([
    ["Clipsal Iconic 2 gang switch", "switch"],
    ["Iconic double power point", "gpo"],
    ["USB power point", "usb"],
    ["Clipsal main switch 63A", "main_switch"],
    ["Hager safety switch", "rcd"],
    ["20A circuit breaker", "mcb"],
    ["Cat6 patch leads 1m", "patch_lead"],
    ["Cat6 data outlet", "data_jack"],
    ["Cat6 cable 305m", "data_cable"],
    ["LED tape 4000K", "strip"],
    ["Insulation tape", "tape"],
    ["20mm conduit saddle", "saddle"],
    ["Junction box", "jb"],
    ["Neon flex", "strip"],
    ["3 core flex", "flex"],
    ["Cable ties 300mm", "tie"],
  ])("%s goes with %s", (name, group) => {
    expect(layoutGroupFor(name)?.group.key).toBe(group);
  });

  it("a name that says nothing has no group", () => {
    expect(layoutGroupFor("Mystery widget")).toBeNull();
  });
});

describe("recommendLayout", () => {
  it("has no plan without racks, and leaves everything else to the rules it writes", () => {
    expect(recommendLayout([], null, { keepRules: true })).toBeNull();
    expect(recommendLayout([], { racks: [], rules: [] }, { keepRules: true })).toBeNull();
  });

  it("puts GPOs beside switches and patch leads beside data jacks", () => {
    const matrix = racks(["1", 4, 6]);
    const { plan, at } = placed(["Iconic switch", "Iconic GPO", "Cat6 patch lead", "Cat6 data jack", "Hager MCB 20A", "Cable ties"], matrix);
    expect(apart(at("switch")!, at("gpo")!, matrix)).toBe(1);
    expect(apart(at("patch lead")!, at("data jack")!, matrix)).toBe(1);
    expect(plan.families.map((f) => f.family.key)).toEqual(["fitoff", "data", "boards", "fixings"]);
  });

  it("keeps groups together around the turn at the end of a shelf", () => {
    const matrix = racks(["1", 2, 2]);
    const { at } = placed(["Switch", "GPO", "USB GPO", "Blank plate"], matrix);
    // Shelf A runs 1→2, shelf b runs back 2→1.
    expect(at("gpo")).toBe("Rack 1 Shelf A, Bin 2");
    expect(at("usb gpo")).toBe("Rack 1 Shelf B, Bin 2");
    expect(at("blank plate")).toBe("Rack 1 Shelf B, Bin 1");
  });

  it("only uses the groups stock has when the usual ones won't all fit", () => {
    const { plan, at } = placed(["Iconic switch", "Cable ties"], racks(["1", 2, 6]));
    expect(plan.families.map((f) => f.family.key)).toEqual(["fitoff", "fixings"]);
    expect(at("switch")).not.toBeNull();
    expect(at("rcbo")).toBeNull();
  });

  it("readies every usual group when there's room, or when there's no stock yet", () => {
    const roomy = recommendLayout([item("1", "Iconic switch")], racks(["1", 10, 10]), { keepRules: true })!;
    expect(roomy.families.map((f) => f.family.key)).toEqual(["fitoff", "data", "boards", "lights", "led", "conduit", "cable", "fixings"]);
    const empty = recommendLayout([], racks(["1", 2, 3]), { keepRules: true })!;
    expect(empty.families).toHaveLength(8);
    expect(empty.shared).toBe(true);
  });

  it("gives each range its own bin, the way 'iconic switch' goes in one bin", () => {
    const matrix = racks(["1", 4, 6]);
    const { plan, at } = placed(["Clipsal Iconic switch", "Clipsal Iconic 2 gang switch"], matrix);
    expect(plan.rules.map((r) => r.words)).toContain("switch");
    expect(plan.rules.some((r) => /iconic/i.test(r.words))).toBe(false);
    expect(at("Clipsal Iconic switch")).toBe(at("Clipsal Iconic 2 gang switch"));

    const ranges = recommendLayout([
      item("1", "Iconic 1 gang switch", { specs: { range: "Iconic" } }),
      item("2", "Iconic 2 gang switch", { specs: { range: "Iconic" } }),
      item("3", "Saturn switch", { specs: { range: "Saturn" } }),
    ], matrix, { keepRules: true })!;
    const proposed: LocationMatrix = { racks: matrix.racks, rules: ranges.rules.map((r, i) => ({ ...r, id: String(i) })) };
    const iconic = ruleFor("Iconic 1 gang switch", proposed)!;
    expect(iconic.rule.words).toBe("Iconic switch");
    expect(ruleFor("Iconic 2 gang switch", proposed)!.location).toBe(iconic.location);
    expect(ruleFor("Saturn switch", proposed)!.location).not.toBe(iconic.location);
    expect(apart(ruleFor("Saturn switch", proposed)!.location, iconic.location, matrix)).toBe(1);
    // A range it hasn't seen still goes with the switches.
    expect(apart(ruleFor("Classic switch", proposed)!.location, iconic.location, matrix)).toBeLessThanOrEqual(3);
  });

  it("doesn't take a range from a spec the label doesn't carry, since a rule couldn't read it", () => {
    const plan = recommendLayout([
      item("1", "1 gang switch", { specs: { range: "Iconic" } }),
      item("2", "2 gang switch", { specs: { range: "Saturn" } }),
    ], racks(["1", 4, 6]), { keepRules: true })!;
    expect(plan.rules.filter((r) => /iconic|saturn/i.test(r.words))).toEqual([]);
    expect(plan.moves).toHaveLength(2);
    expect(plan.unsorted).toEqual([]);
  });

  it("splits by brand when there's no range", () => {
    const matrix = racks(["1", 4, 6]);
    const { at } = placed(["Hager MCB 20A", "NHP MCB 20A"], matrix);
    const plan = recommendLayout([item("1", "20A MCB", { brand: "Hager" }), item("2", "20A MCB", { brand: "NHP" })], matrix, { keepRules: true })!;
    expect(plan.rules.map((r) => r.words)).toEqual(expect.arrayContaining(["Hager mcb", "NHP mcb", "mcb"]));
    expect(at("MCB")).not.toBeNull();
  });

  it("keeps rules already set, grows that family around them, and doesn't repeat them", () => {
    const matrix: LocationMatrix = { ...racks(["1", 3, 6], ["3", 3, 6]), rules: [{ id: "r", words: "iconic switch", rackId: "3", shelf: 2, bin: 4 }] };
    const plan = recommendLayout([item("1", "Iconic switch"), item("2", "Classic switch"), item("3", "Iconic GPO")], matrix, { keepRules: true })!;
    expect(plan.kept).toHaveLength(1);
    const proposed: LocationMatrix = { racks: matrix.racks, rules: [...plan.kept, ...plan.rules.map((r, i) => ({ ...r, id: String(i) }))] };
    expect(ruleFor("Iconic switch", proposed)!.location).toBe("Rack 3 Shelf B, Bin 4");
    expect(plan.rules.some((r) => r.words.toLowerCase() === "iconic switch")).toBe(false);
    expect(plan.bins.has(binKey("3", 2, 4))).toBe(false);
    const gpo = ruleFor("Iconic GPO", proposed)!;
    expect(gpo.rack.id).toBe("3");
    expect(apart(gpo.location, "Rack 3 Shelf B, Bin 4", matrix)).toBeLessThanOrEqual(2);
  });

  it("starting over ignores the old rules and replaces them", () => {
    const matrix: LocationMatrix = { ...racks(["1", 2, 6], ["3", 2, 6]), rules: [{ id: "r", words: "switch", rackId: "3", shelf: 2, bin: 4 }] };
    const plan = recommendLayout([item("1", "Switch")], matrix, { keepRules: false })!;
    expect(plan.kept).toEqual([]);
    expect(plan.rules.find((r) => r.words === "switch")).toMatchObject({ rackId: "1", shelf: 1, bin: 1 });
  });

  it("offers nothing new once every group already has its rule, however often it's run", () => {
    const matrix = racks(["1", 4, 6]);
    const first = recommendLayout([item("1", "Switch"), item("2", "GPO")], matrix, { keepRules: true })!;
    const saved: LocationMatrix = { racks: matrix.racks, rules: first.rules.map((r, i) => ({ ...r, id: String(i) })) };
    const again = recommendLayout([item("1", "Switch"), item("2", "GPO")], saved, { keepRules: true })!;
    expect(again.moves).toHaveLength(2);
    expect(again.rules).toEqual([]);
  });

  it("leaves bins alone that hold stock no group covers, and says so", () => {
    const matrix = racks(["1", 1, 3]);
    const plan = recommendLayout([item("1", "Mystery widget", { location: "Rack 1 Shelf A, Bin 1" }), item("2", "Switch"), item("3", "GPO")], matrix, { keepRules: true })!;
    expect(plan.bins.has(binKey("1", 1, 1))).toBe(false);
    expect(plan.unsorted.map((i) => i.id)).toEqual(["1"]);
    expect(plan.rules.find((r) => r.words === "switch")?.bin).toBe(2);
  });

  it("counts what stays and what moves, never archived stock", () => {
    const matrix = racks(["1", 2, 6]);
    const first = recommendLayout([item("1", "Switch"), item("2", "GPO")], matrix, { keepRules: true })!;
    const switchBin = first.rules.find((r) => r.words === "switch")!;
    const plan = recommendLayout([
      item("1", "Switch", { location: locationText(matrix.racks[0]!, switchBin.shelf, switchBin.bin) }),
      item("2", "GPO", { location: "Shelf A2" }),
      item("3", "Old GPO", { archivedAt: "2026-01-01" }),
    ], matrix, { keepRules: true })!;
    expect(plan.stays).toBe(1);
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0]).toMatchObject({ from: "Shelf A2", item: { id: "2" } });
  });

  it("starts a family on the next rack rather than splitting it, when there's room to spare", () => {
    const { plan } = placed(["Switch", "MCB", "RCBO", "RCD"], racks(["1", 1, 3], ["2", 1, 6]));
    expect(plan.families.find((f) => f.family.key === "boards")).toMatchObject({ from: "Rack 2 Shelf A, Bin 1", to: expect.stringMatching(/^Rack 2/) });
  });

  it("splits a family over two racks when there's no room to do otherwise", () => {
    const { plan, at } = placed(["Switch", "GPO", "MCB", "RCBO", "RCD", "Isolator"], racks(["1", 1, 3], ["2", 1, 3]));
    expect(plan.shared).toBe(false);
    expect(at("mcb")).toBe("Rack 1 Shelf A, Bin 3");
    expect(at("isolator")).toBe("Rack 2 Shelf A, Bin 3");
  });

  it("leaves free bins after a family, shared out, and counts the rest as spare", () => {
    const { plan } = placed(["Switch", "GPO", "Cable ties"], racks(["1", 1, 6]));
    const bins = [1, 2, 3, 4, 5, 6].map((n) => plan.bins.get(binKey("1", 1, n))?.labels ?? null);
    expect(bins[0]).toEqual(["Switches"]);
    expect(bins[1]).toEqual(["GPOs"]);
    expect(bins[2]).toEqual([]);
    expect(plan.spare).toBe(6 - plan.bins.size);
  });

  it("shares bins between neighbours rather than dropping anything when there aren't enough", () => {
    const names = ["Switch", "GPO", "Dimmer", "USB GPO", "Blank plate"];
    const { plan, at } = placed(names, racks(["1", 1, 2]));
    expect(plan.shared).toBe(true);
    expect(plan.spare).toBe(0);
    for (const name of names) expect(at(name)).not.toBeNull();
  });

  it("every rule it writes fits the matrix's save limits and lands on a real bin", () => {
    const matrix = racks(["1", 3, 4], ["2", 26, 60]);
    const plan = recommendLayout([], matrix, { keepRules: true })!;
    expect(plan.rules.length).toBeLessThanOrEqual(1000);
    for (const r of plan.rules) {
      const rack = matrix.racks.find((x) => x.id === r.rackId)!;
      expect(r.words.length).toBeLessThanOrEqual(80);
      expect(r.shelf).toBeLessThanOrEqual(rack.shelves);
      expect(r.bin).toBeLessThanOrEqual(rack.bins);
    }
  });
});

describe("uneven shelves", () => {
  it("only plans bins each shelf has, and the path still turns back at each shelf's end", () => {
    const matrix: LocationMatrix = { racks: [{ id: "1", name: "1", shelves: 3, bins: 6, shelfBins: [2, 6, 3] }], rules: [] };
    const names = ["Iconic switch", "Iconic GPO", "Cat6 data jack", "Cat6 patch lead", "20A mcb", "rcbo 20A", "Downlight 10W", "Batten 1200", "TPS 2.5mm", "Cable tie 300mm"];
    const plan = recommendLayout(names.map((n, i) => item(String(i), n)), matrix, { keepRules: true })!;
    for (const key of plan.bins.keys()) {
      const [, shelf, bin] = key.split(":").map(Number);
      expect(bin).toBeLessThanOrEqual(matrix.racks[0]!.shelfBins![shelf! - 1]!);
    }
    for (const r of plan.rules) expect(binAt(locationText(matrix.racks[0]!, r.shelf, r.bin), matrix)).not.toBeNull();
    expect(plan.spare + plan.bins.size).toBe(11);
  });
});

