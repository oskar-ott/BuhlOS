import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { balanceLabel, errorCopy, formatQuantity, matchesSearch, movementSummary, parseTypedQuantity, signedQuantity } from "./format";
import { decideRead, packSuggestion, stepQuantity, suggestName } from "./flow";
import { clearPending, isUncertain, readPending, rememberPending, setPendingOwner } from "./pending";
import type { ReadPhotoResult, ReadProduct } from "./schema";

/**
 * Workshop Stock — the pure client decisions behind the phone screens.
 * The server re-validates everything; these keep the screens honest and fast.
 */

const product = (over: Partial<ReadProduct> = {}): ReadProduct => ({
  brand: "Clipsal", manufacturerCode: "2025WE", supplierSku: null, supplierName: null, description: "Double power point",
  colourFinish: "White", variantDetails: ["10A"], barcode: null, packQuantity: null, packUnit: null, labelText: [], position: "only product", ...over,
});
const candidateItem = { id: "i1", name: "Clipsal double GPO", brand: "Clipsal", manufacturerCode: "2025WE", supplierSku: null, supplierName: null, variant: "10A", colourFinish: "white", location: "Shelf A2", baseUnit: "each" as const, balanceMilli: 42_000, estimated: false, version: 3, photoId: null, defaultPack: null, identifiers: [] };
const read = (over: Partial<ReadPhotoResult> = {}): ReadPhotoResult => ({
  readStatus: "ok",
  reading: { legibility: "clear", note: null, products: [product()] },
  matches: [{ productIndex: 0, outcome: "exact", candidates: [{ itemId: "i1", evidence: "manufacturer_code", strength: 90, matchedValue: "2025WE", identifierId: "x", conflicts: [], notes: [] }] }],
  candidateItems: [candidateItem],
  photoId: null,
  photoStored: null,
  ...over,
});

describe("decideRead", () => {
  it("an exact code match goes straight to confirmation of that item", () => {
    expect(decideRead(read(), null)).toMatchObject({ kind: "exact", item: { id: "i1" }, candidate: { evidence: "manufacturer_code" } });
  });
  it("several products → ask which one (never guess)", () => {
    const r = read({ reading: { legibility: "clear", note: null, products: [product(), product({ manufacturerCode: "30MBPR", description: "Switch" })] } });
    expect(decideRead(r, null)).toMatchObject({ kind: "pick-product" });
    expect(decideRead(r, 0)).toMatchObject({ kind: "exact" });
    expect(decideRead(r, 1)).toMatchObject({ kind: "none", productIndex: 1 });
  });
  it("weaker evidence is a candidate list; nothing is 'none'; failures are statuses", () => {
    const cands = read({ matches: [{ productIndex: 0, outcome: "candidates", candidates: [{ itemId: "i1", evidence: "description", strength: 20, matchedValue: null, identifierId: null, conflicts: [], notes: [] }] }] });
    expect(decideRead(cands, null)).toMatchObject({ kind: "candidates", candidates: [{ item: { id: "i1" } }] });
    expect(decideRead(read({ matches: [{ productIndex: 0, outcome: "none", candidates: [] }] }), null)).toMatchObject({ kind: "none" });
    expect(decideRead(read({ readStatus: "unavailable", reading: null, matches: [] }), null)).toEqual({ kind: "status", status: "unavailable" });
    expect(decideRead(read({ reading: { legibility: "unreadable", note: null, products: [] }, matches: [] }), null)).toEqual({ kind: "status", status: "unreadable" });
  });
});

describe("quantities on the phone", () => {
  it("steps by the unit and never below the floor", () => {
    expect(stepQuantity(1000, "each", 1)).toBe(2000);
    expect(stepQuantity(1000, "each", -1, 1000)).toBe(1000);
    expect(stepQuantity(12_500, "metre", 1)).toBe(12_600);
    expect(stepQuantity(100, "metre", -1, 100)).toBe(100);
  });
  it("parses typed quantities like the server does", () => {
    expect(parseTypedQuantity("12", "each")).toBe(12_000);
    expect(parseTypedQuantity("12,5", "metre")).toBe(12_500);
    expect(parseTypedQuantity("1.5", "each")).toBeNull();
    expect(parseTypedQuantity("0", "each")).toBeNull();
    expect(parseTypedQuantity("0", "each", { allowZero: true })).toBe(0);
    expect(parseTypedQuantity("abc", "each")).toBeNull();
  });
  it("labels recorded stock honestly", () => {
    expect(balanceLabel({ balanceMilli: 0, baseUnit: "each", estimated: false })).toBe("None recorded");
    expect(balanceLabel({ balanceMilli: 40_000, baseUnit: "metre", estimated: true })).toBe("≈ 40 m (estimate)");
    expect(formatQuantity(1000, "box")).toBe("1 box");
    expect(signedQuantity(-2000, "each")).toBe("−2 each");
    expect(movementSummary({ kind: "add", quantityMilli: 20_000, countedMilli: null, pack: { count: 2, unit: "box", sizeMilli: 10_000 } }, "each")).toBe("Added 20 each (2 boxes)");
    expect(movementSummary({ kind: "count", quantityMilli: -1000, countedMilli: 40_000, pack: null }, "each")).toBe("Counted 40 each");
  });
  it("offers a printed pack size only when it counts the item's unit", () => {
    expect(packSuggestion(product({ packQuantity: 10, packUnit: "each" }), "each")).toMatchObject({ sizeMilli: 10_000 });
    expect(packSuggestion(product({ packQuantity: 100, packUnit: "metre" }), "each")).toBeNull();
    expect(packSuggestion(product({ packQuantity: null }), "each")).toBeNull();
  });
  it("suggests a name from what's printed, without inventing anything", () => {
    expect(suggestName(product())).toBe("Clipsal Double power point — White 10A");
    expect(suggestName(product({ brand: null, description: null, colourFinish: null, variantDetails: [] }))).toBe("2025WE");
    expect(suggestName(null)).toBe("");
  });
});

describe("search and failure copy", () => {
  const item = { name: "Clipsal double GPO", brand: "Clipsal", manufacturerCode: "2025WE", supplierSku: "CLI-2025WE", location: "Shelf A2", variant: "10A", colourFinish: "white", identifiers: [{ id: "x", kind: "barcode" as const, value: "4006381333931", valueKey: "", scope: "", packUnit: null, packSizeMilli: null }] };
  it("matches every word across name, codes, shelf and barcode — punctuation-insensitive", () => {
    expect(matchesSearch(item, "gpo shelf a2")).toBe(true);
    expect(matchesSearch(item, "2025-we")).toBe(true);
    expect(matchesSearch(item, "4006381333931")).toBe(true);
    expect(matchesSearch(item, "black")).toBe(false);
    expect(matchesSearch(item, "")).toBe(true);
  });
  it("speaks site language for the refusals that matter", () => {
    expect(errorCopy(409, { error: "insufficient_stock", recorded: "2 each" })).toMatch(/Only 2 each recorded/);
    expect(errorCopy(0, null)).toMatch(/Not saved — no signal/);
    expect(errorCopy(401, null)).toMatch(/signed out/);
    expect(errorCopy(409, { error: "undo_would_go_negative", recorded: "2 each" })).toMatch(/Can't undo/);
    expect(errorCopy(409, { error: "unit_locked" })).toMatch(/Archive this item/);
  });
  it("treats no-signal and server errors as UNCERTAIN, refusals as definite", () => {
    expect(isUncertain(0)).toBe(true);
    expect(isUncertain(502)).toBe(true);
    expect(isUncertain(409)).toBe(false);
    expect(isUncertain(400)).toBe(false);
  });
});

describe("a pending save on the phone", () => {
  const store = new Map<string, string>();
  const g = globalThis as unknown as { window?: unknown };
  const pending = { key: "op-key-0001", kind: "take" as const, itemId: "i1", itemName: "Clipsal double GPO", quantityLabel: "3 each", request: { itemId: "i1", kind: "take", quantity: "3" }, startedAt: new Date().toISOString() };
  beforeEach(() => {
    store.clear();
    g.window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } };
  });
  afterEach(() => {
    delete g.window;
    setPendingOwner(null);
  });

  it("survives a reload, but is only ever read back for the person who made it", () => {
    setPendingOwner("u_sam");
    rememberPending(pending);
    expect(readPending("u_sam")).toMatchObject({ key: "op-key-0001", userId: "u_sam" });
    expect(readPending("u_jo")).toBeNull(); // the next worker on a shared phone never sees or re-sends it
    clearPending();
    expect(readPending("u_sam")).toBeNull();
  });

  it("a save remembered before the viewer was known can't be reconciled; a day-old one is dropped", () => {
    rememberPending(pending);
    expect(readPending("u_sam")).toBeNull();
    setPendingOwner("u_sam");
    rememberPending({ ...pending, startedAt: new Date(Date.now() - 25 * 3600_000).toISOString() });
    expect(readPending("u_sam")).toBeNull();
    expect(store.size).toBe(0);
  });
});

