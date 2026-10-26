import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { barcodeKey, cleanBarcode, findByBarcode } from "./barcode";
import { clockTime, movementWho, undoLabelFor, undoUntilLabel, verificationLine, whenLabel } from "./format";
import { binOf, groupByShelf, NO_SHELF_LABEL, splitLocation } from "./location";
import { clearAllOften, oftenTaken, rememberTaken } from "./often";
import type { StockIdentifier } from "./schema";

const requireFromHere = createRequire(import.meta.url);

describe("where an item lives: shelf and bin", () => {
  it("splits on the first separator and keeps the text as typed", () => {
    expect(splitLocation("Shelf A2, Bin 4")).toEqual({ shelf: "Shelf A2", bin: "Bin 4" });
    expect(splitLocation("Rack C / slot 3")).toEqual({ shelf: "Rack C", bin: "slot 3" });
    expect(splitLocation("Shelf B1 · top")).toEqual({ shelf: "Shelf B1", bin: "top" });
    expect(splitLocation("Cable bay - left")).toEqual({ shelf: "Cable bay", bin: "left" });
    expect(splitLocation("Breaker drawer")).toEqual({ shelf: "Breaker drawer", bin: null });
    expect(splitLocation("  ")).toEqual({ shelf: null, bin: null });
    expect(splitLocation(null)).toEqual({ shelf: null, bin: null });
    // a dash inside a word is not a separator
    expect(splitLocation("Shelf A-2")).toEqual({ shelf: "Shelf A-2", bin: null });
    expect(binOf("Shelf A2, Bin 4")).toBe("Bin 4");
  });

  it("groups by shelf in natural order, names sorted, the unlocated last", () => {
    const items = [
      { id: "1", name: "Hager MCB 20A", location: "Breaker drawer" },
      { id: "2", name: "Clipsal single GPO", location: "Shelf A2, Bin 3" },
      { id: "3", name: "Olex 2.5 TPS", location: null },
      { id: "4", name: "Clipsal double GPO", location: "shelf a2, Bin 4" },
      { id: "5", name: "Blank plate", location: "Shelf A10" },
      { id: "6", name: "Switch", location: "Shelf A3" },
    ];
    const groups = groupByShelf(items);
    expect(groups.map((g) => g.label)).toEqual(["Breaker drawer", "Shelf A2", "Shelf A3", "Shelf A10", NO_SHELF_LABEL]);
    expect(groups[1]!.items.map((i) => i.name)).toEqual(["Clipsal double GPO", "Clipsal single GPO"]);
    expect(groups[4]!.shelf).toBeNull();
  });
});

describe("barcodes read on the phone match the server's keys", () => {
  const codes = requireFromHere("../../../api/_lib/workshop-stock/codes.js");
  const cases = ["9300704010017", "93007040 10017", "9300704010018", "12345670", "012345678905", "00000000", "abc", "", "9300704010017x", 9300704010017];

  it("a barcode is digits with a valid check digit or nothing, compared as GTIN-14", () => {
    for (const c of cases) {
      expect(cleanBarcode(c)).toEqual(codes.cleanBarcode(c));
      expect(barcodeKey(c)).toEqual(codes.barcodeKey(c));
    }
    expect(barcodeKey("9300704010017")).toBe("09300704010017");
    expect(barcodeKey("9300704010018")).toBeNull();
  });

  it("finds the live item that carries the code; several share it → several; archived never", () => {
    const id = (value: string, extra: Partial<StockIdentifier> = {}): StockIdentifier => ({ id: `i-${value}`, kind: "barcode", value, valueKey: barcodeKey(value)!, scope: "", packUnit: null, packSizeMilli: null, ...extra });
    const gpo = { id: "a", identifiers: [id("9300704010017"), id("9300704010024", { packUnit: "box", packSizeMilli: 10_000 })], archivedAt: null };
    const twin = { id: "b", identifiers: [id("9300704010017")], archivedAt: null };
    const gone = { id: "c", identifiers: [id("9300704010017")], archivedAt: "2026-10-01T00:00:00Z" };
    expect(findByBarcode([gpo, gone], "9300704010017").map((h) => h.item.id)).toEqual(["a"]);
    expect(findByBarcode([gpo, twin, gone], "9300704010017").map((h) => h.item.id)).toEqual(["a", "b"]);
    const pack = findByBarcode([gpo], "9300704010024");
    expect(pack[0]!.identifier.packSizeMilli).toBe(10_000);
    expect(findByBarcode([gpo], "9300704010018")).toEqual([]);
    expect(findByBarcode([gpo], "not a code")).toEqual([]);
  });
});

describe("receipt copy", () => {
  const now = Date.parse("2026-10-26T07:50:00+11:00");

  it("says times and days the way a worker does", () => {
    expect(clockTime("2026-10-26T07:42:00+11:00")).toBe("7:42am");
    expect(clockTime("2026-10-26T16:28:00+11:00")).toBe("4:28pm");
    expect(clockTime(null)).toBeNull();
    expect(whenLabel("2026-10-26T07:42:00+11:00", now)).toBe("7:42am");
    expect(whenLabel("2026-10-23T09:00:00+11:00", now)).toBe("Fri 23 Oct");
    expect(whenLabel("2026-10-12T09:00:00+11:00", now)).toBe("12 Oct");
    expect(whenLabel(null, now)).toBe("—");
  });

  it("the undo line appears only while the server allows the undo", () => {
    expect(undoUntilLabel({ allowed: true, until: "2026-10-26T08:12:00+11:00" })).toBe("You can undo this until 8:12am.");
    expect(undoUntilLabel({ allowed: false, until: "2026-10-26T08:12:00+11:00" })).toBeNull();
    expect(undoUntilLabel({ allowed: true })).toBeNull();
    expect(undoLabelFor("take")).toBe("Undo take");
    expect(undoLabelFor("return")).toBe("Undo return");
  });

  it("the code status carries its reason", () => {
    expect(verificationLine({ verificationStatus: "possible_match", verification: { reasons: ["Colour not confirmed."] } })).toBe("Possible match — colour not confirmed");
    expect(verificationLine({ verificationStatus: "possible_match", verification: null })).toBe("Possible match");
    expect(verificationLine({ verificationStatus: "manufacturer_code_matched", verification: { reasons: ["x"] } })).toBe("Manufacturer code matched");
    expect(movementWho({ actorId: "u1", actorName: "Dan", createdAt: "2026-10-26T07:42:00+11:00", jobLabel: "IV1240 Mascot fit-off" }, "u1", now)).toBe("You · 7:42am · note: IV1240 Mascot fit-off");
    expect(movementWho({ actorId: "u2", actorName: "Marco", createdAt: "2026-10-23T09:00:00+11:00", jobLabel: null }, "u1", now)).toBe("Marco · Fri 23 Oct");
  });
});

describe("'you often take' on this phone", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    Object.defineProperty(globalThis, "window", {
      value: { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } },
      configurable: true,
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
  });
  const items = [{ id: "gpo" }, { id: "mcb" }, { id: "tps" }, { id: "old", archivedAt: "2026-01-01T00:00:00Z" }];

  it("most taken first, only this viewer's, only items still on the list", () => {
    rememberTaken("dan", "gpo");
    rememberTaken("dan", "gpo");
    rememberTaken("dan", "mcb");
    rememberTaken("dan", "old");
    rememberTaken("dan", "gone");
    rememberTaken("priya", "tps");
    expect(oftenTaken("dan", items).map((i) => i.id)).toEqual(["gpo", "mcb"]);
    expect(oftenTaken("priya", items).map((i) => i.id)).toEqual(["tps"]);
    expect(oftenTaken(null, items)).toEqual([]);
    expect(oftenTaken("dan", items, 1).map((i) => i.id)).toEqual(["gpo"]);
  });

  it("fades after 90 days and is gone after sign-out", () => {
    const old = Date.parse("2026-01-01T00:00:00Z");
    rememberTaken("dan", "mcb", old);
    rememberTaken("dan", "gpo");
    expect(oftenTaken("dan", items).map((i) => i.id)).toEqual(["gpo"]);
    clearAllOften();
    expect(oftenTaken("dan", items)).toEqual([]);
  });

  it("without storage it simply remembers nothing", () => {
    Reflect.deleteProperty(globalThis, "window");
    expect(() => rememberTaken("dan", "gpo")).not.toThrow();
    expect(oftenTaken("dan", items)).toEqual([]);
  });
});
