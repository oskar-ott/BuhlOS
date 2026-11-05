import { describe, expect, it } from "vitest";
import { identityLine, matchesSearch } from "./format";
import { applyFacets, facetsFor, fieldChoices, guessSpecs, guessType, itemsOfType, normaliseValue, NOT_SORTED_LABEL, setCustomTypes, specsForType, STOCK_TYPES, suggestTypedName, typeNameTaken, typeOf, typeTiles } from "./types";

const SW = typeOf("switches")!;
const LED = typeOf("led_strip")!;
const field = (t: typeof SW, key: string) => t.fields.find((f) => f.key === key)!;

type It = { id: string; name: string; brand: string | null; colourFinish: string | null; category?: string | null; specs?: Record<string, string> };
const mk = (id: string, category: string | null, specs: Record<string, string>, brand: string | null = "Clipsal", colourFinish: string | null = "White"): It => ({ id, name: `item ${id}`, brand, colourFinish, category, specs });

describe("the type catalogue", () => {
  it("has unique keys, each with a label and at least one field; switches carry range, what it is, gang and colour", () => {
    const keys = STOCK_TYPES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const t of STOCK_TYPES) {
      expect(t.label).toBeTruthy();
      expect(t.fields.length).toBeGreaterThan(0);
      expect(new Set(t.fields.map((f) => f.key)).size).toBe(t.fields.length);
    }
    expect(SW.fields.map((f) => f.key)).toEqual(["brand", "range", "kind", "gang", "colourFinish"]);
    expect(LED.fields.map((f) => f.key)).toEqual(expect.arrayContaining(["cct", "voltage", "width", "length", "brand"]));
    expect(typeOf("cable")!.unit).toBe("metre");
  });
  it("an unknown saved key reads as Other; none is not sorted", () => {
    expect(typeOf("made_up")!.key).toBe("other");
    expect(typeOf(null)).toBeNull();
  });
});

describe("normaliseValue — what was typed, the way a sparky writes it", () => {
  it.each([
    [field(SW, "gang"), "2g", "2 gang"],
    [field(SW, "gang"), "2 Gang", "2 gang"],
    [field(SW, "gang"), "double", "2 gang"],
    [field(LED, "cct"), "4000k", "4000K"],
    [field(LED, "voltage"), "24 v", "24V"],
    [field(LED, "voltage"), "24vdc", "24V DC"],
    [field(LED, "width"), "10", "10mm"],
    [field(LED, "width"), "10 MM", "10mm"],
    [field(LED, "length"), "5 metres", "5m"],
    [field(LED, "watts_per_m"), "14.4 w/m", "14.4W/m"],
    [field(LED, "ip"), "ip65", "IP65"],
    [field(typeOf("cable")!, "size"), "2.5mm2", "2.5mm²"],
    [field(typeOf("cable")!, "size"), "2,5", "2.5mm²"],
    [field(typeOf("cable")!, "cores"), "2c+e", "2C+E"],
    [field(typeOf("cable")!, "cores"), "twin and earth", "2C+E"],
    [field(typeOf("breakers")!, "rating"), "20 amp", "20A"],
    [field(typeOf("breakers")!, "poles"), "2 pole", "2P"],
    [field(SW, "range"), "iconic", "Iconic"],
    [field(SW, "range"), "  saturn   zen ", "Saturn Zen"],
    [field(SW, "range"), "Something new", "Something new"],
  ])("%#: %s → %s", (f, raw, want) => {
    expect(normaliseValue(f, raw as string)).toBe(want);
  });
});

describe("guessType / guessSpecs — fills a form from a label or a name, for a person to check", () => {
  it("reads the type from label words, the specific before the general", () => {
    expect(guessType(["CLIPSAL ICONIC", "2 GANG SWITCH 10A"])).toBe("switches");
    expect(guessType(["Clipsal double GPO white"])).toBe("switches");
    expect(guessType(["LED STRIP 24V 4000K 10MM 5M"])).toBe("led_strip");
    expect(guessType(["LED DRIVER 24V 100W"])).toBe("led_driver");
    expect(guessType(["2.5mm² TPS twin and earth 100m"])).toBe("cable");
    expect(guessType(["Cable ties 300mm black"])).toBe("fixings");
    expect(guessType(["RCBO 20A 1P C curve"])).toBe("breakers");
    expect(guessType(["Safety switch 2 pole"])).toBe("breakers");
    expect(guessType(["10W LED downlight tri-colour 90mm"])).toBe("lights");
    expect(guessType(["20mm corrugated conduit grey"])).toBe("conduit");
    expect(guessType(["nothing we know"])).toBeNull();
    expect(guessType([null, ""])).toBeNull();
  });
  it("a Clipsal Iconic 2 gang switch plate: range, what it is, gang — and brand/colour only when asked", () => {
    const texts = ["Clipsal Iconic 2 gang switch plate", "Vivid white"];
    expect(guessSpecs("switches", texts)).toEqual({ range: "Iconic", kind: "Switch", gang: "2 gang" });
    expect(guessSpecs("switches", texts, { columns: true })).toEqual({ brand: "Clipsal", range: "Iconic", kind: "Switch", gang: "2 gang", colourFinish: "Vivid white" });
    expect(guessSpecs("switches", ["Clipsal 2000 series double GPO"])).toMatchObject({ range: "Classic", kind: "GPO", gang: "2 gang" });
    expect(guessSpecs("switches", ["Saturn Zen 1 gang dimmer"])).toMatchObject({ range: "Saturn Zen", kind: "Dimmer", gang: "1 gang" });
  });
  it("LED strip: colour temp, voltage, width, length, watts per metre, IP — and a 10mm width isn't a 10m length", () => {
    expect(guessSpecs("led_strip", ["LED STRIP 4000K 24VDC 10MM 14.4W/M IP20 5M ROLL"])).toEqual({
      cct: "4000K", voltage: "24V", width: "10mm", length: "5m", watts_per_m: "14.4W/m", ip: "IP20",
    });
    expect(guessSpecs("led_strip", ["RGBW strip 24V"])).toMatchObject({ cct: "RGBW", voltage: "24V" });
  });
  it("cable, breakers, lights", () => {
    expect(guessSpecs("cable", ["2.5mm2 TPS twin and earth white 100m"])).toMatchObject({ cable_type: "TPS", size: "2.5mm²", cores: "2C+E" });
    expect(guessSpecs("breakers", ["Clipsal RCBO C20 1 pole"])).toMatchObject({ kind: "RCBO", rating: "20A", poles: "1P", curve: "C" });
    expect(guessSpecs("lights", ["10W LED downlight tri-colour 90mm cut-out dimmable"])).toMatchObject({ kind: "Downlight", watts: "10W", cct: "Tri-colour", cutout: "90mm", dimmable: "Dimmable" });
  });
  it("suggests a name from the fields — never from the brand alone", () => {
    expect(suggestTypedName("switches", { brand: "Clipsal", range: "Iconic", gang: "2 gang", kind: "Switch" })).toBe("Clipsal Iconic 2 gang switch");
    expect(suggestTypedName("switches", { brand: "Clipsal", range: "Iconic", gang: "2 gang", kind: "GPO" })).toBe("Clipsal Iconic 2 gang GPO");
    expect(suggestTypedName("cable", { size: "2.5mm²", cores: "2C+E", cable_type: "TPS" })).toBe("2.5mm² 2C+E TPS");
    expect(suggestTypedName("led_strip", { cct: "4000K", voltage: "24V" })).toBe("LED strip 4000K 24V");
    expect(suggestTypedName("switches", { brand: "Clipsal" })).toBeNull();
    expect(suggestTypedName(null, { range: "Iconic" })).toBeNull();
  });
});

describe("browsing: tiles and filters built from what's in stock", () => {
  const items: It[] = [
    mk("a", "switches", { range: "Iconic", kind: "Switch", gang: "2 gang" }),
    mk("b", "switches", { range: "Iconic", kind: "Switch", gang: "1 gang" }),
    mk("c", "switches", { range: "Classic", kind: "Switch", gang: "2 gang" }),
    mk("d", "switches", { range: "Iconic", kind: "GPO", gang: "2 gang" }, "Clipsal", "Black"),
    mk("e", "led_strip", { cct: "4000K", voltage: "24V" }, null, null),
    mk("f", null, {}),
    mk("g", "mystery", {}, null, null),
  ];
  it("one tile per type in stock, in catalogue order, unknown keys as Other, then Not sorted yet", () => {
    const tiles = typeTiles(items);
    expect(tiles.map((t) => [t.label, t.count])).toEqual([["Switches & GPOs", 4], ["LED strip", 1], ["Other", 1], [NOT_SORTED_LABEL, 1]]);
    expect(tiles[0]!.sample).toEqual(["Iconic", "Classic"]);
    expect(itemsOfType(items, null).map((i) => i.id)).toEqual(["f"]);
    expect(itemsOfType(items, "other").map((i) => i.id)).toEqual(["g"]);
  });
  it("a field is a filter once its items differ on it; counts follow the other chosen filters", () => {
    const sw = itemsOfType(items, "switches");
    const f0 = facetsFor(SW, sw, {});
    expect(f0.map((f) => f.field.key)).toEqual(["range", "kind", "gang", "colourFinish"]); // one brand → no brand filter
    const range = f0.find((f) => f.field.key === "range")!;
    expect(range.values.map((v) => [v.value, v.count])).toEqual([["Iconic", 3], ["Classic", 1]]);
    const gang = f0.find((f) => f.field.key === "gang")!;
    expect(gang.values.map((v) => v.value)).toEqual(["1 gang", "2 gang"]);

    const chosen = { range: "iconic", gang: "2 gang" };
    expect(applyFacets(SW, sw, chosen).map((i) => i.id).sort()).toEqual(["a", "d"]);
    const f1 = facetsFor(SW, sw, chosen);
    expect(f1.find((f) => f.field.key === "range")!.values.map((v) => [v.value, v.count])).toEqual([["Iconic", 2], ["Classic", 1]]);
    expect(f1.find((f) => f.field.key === "kind")!.values.map((v) => [v.value, v.count])).toEqual([["Switch", 1], ["GPO", 1]]);
  });
  it("offers the shop's own values first, then the common ones", () => {
    const choices = fieldChoices(SW, field(SW, "range"), items, 4);
    expect(choices).toEqual(["Iconic", "Classic", "Saturn", "Saturn Zen"]);
  });
});

describe("the identity line and search know the type", () => {
  const typed = { name: "Clipsal Iconic 2 gang switch", brand: "Clipsal", manufacturerCode: "3042WE", supplierSku: null, location: "Shelf B", variant: null, colourFinish: "White", identifiers: [], category: "switches", specs: { range: "Iconic", kind: "Switch", gang: "2 gang" } };
  it("reads in the type's fields, then the code", () => {
    expect(identityLine(typed)).toBe("Clipsal · Iconic · Switch · 2 gang · White · 3042WE");
    expect(identityLine({ ...typed, category: null })).toBe("Clipsal · 3042WE · White");
  });
  it("finds it by its fields and its type", () => {
    expect(matchesSearch(typed, "iconic 2 gang")).toBe(true);
    expect(matchesSearch(typed, "switches")).toBe(true);
    expect(matchesSearch({ ...typed, name: "Plate", specs: { range: "Classic" } }, "iconic")).toBe(false);
  });
});

describe("categories the office makes (2026-11-03)", () => {
  const t = { setCustomTypes, STOCK_TYPES, typeOf, specsForType, typeNameTaken };
  const solar = { key: "c_solar_inverters", label: "Solar inverters", unit: "each" as const, fields: [{ key: "power", label: "Power" }, { key: "phase", label: "Phase" }] };

  it("join the catalogue after the built-in ones and before Other, and are found by key", () => {
    t.setCustomTypes([solar]);
    try {
      const keys = t.STOCK_TYPES.map((x) => x.key);
      expect(keys.indexOf("c_solar_inverters")).toBe(keys.length - 2);
      expect(keys[keys.length - 1]).toBe("other");
      const type = t.typeOf("c_solar_inverters")!;
      expect(type.label).toBe("Solar inverters");
      expect(type.fields.map((f) => f.label)).toEqual(["Brand", "Power", "Phase"]);
      expect(type.fields.slice(1).every((f) => f.facet)).toBe(true);
    } finally {
      t.setCustomTypes([]);
    }
  });

  it("keep their own fields as specs and suggest a name from them", () => {
    t.setCustomTypes([solar]);
    try {
      expect(t.specsForType("c_solar_inverters", { power: " 5kW ", phase: "Single", other: "x" })).toEqual({ power: "5kW", phase: "Single" });
      expect(t.typeOf("c_solar_inverters")!.name({ brand: "Fronius", power: "5kW", phase: "Single" })).toBe("Fronius 5kW Single");
    } finally {
      t.setCustomTypes([]);
    }
  });

  it("a new set replaces the last one; a category not (yet) known reads as Other, never lost", () => {
    t.setCustomTypes([solar]);
    t.setCustomTypes([]);
    expect(t.STOCK_TYPES.some((x) => x.key === "c_solar_inverters")).toBe(false);
    expect(t.typeOf("c_solar_inverters")!.key).toBe("other");
    expect(t.typeOf("switches")!.key).toBe("switches"); // built-ins untouched
  });

  it("a name already taken (built-in or the office's) is spotted, loosely", () => {
    t.setCustomTypes([solar]);
    try {
      expect(t.typeNameTaken(" cable ")?.key).toBe("cable");
      expect(t.typeNameTaken("solar INVERTERS")?.key).toBe("c_solar_inverters");
      expect(t.typeNameTaken("Solar inverters", "c_solar_inverters")).toBeNull(); // renaming itself
      expect(t.typeNameTaken("Heat pumps")).toBeNull();
    } finally {
      t.setCustomTypes([]);
    }
  });
});
