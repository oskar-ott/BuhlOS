import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { balanceLabel, errorCopy, formatQuantity, matchesSearch, movementSummary, parseTypedQuantity, photoUrl, recordedNow, signedQuantity, unitHint } from "./format";
import { decideRead, freshestItem, packSuggestion, stepQuantity, suggestName } from "./flow";
import { clearAllPending, clearPending, definitelyNotSaved, isUncertain, readPending, rememberPending, setPendingOwner } from "./pending";
import * as check from "./check";
import * as tradeTerms from "./trade-terms";
import type { ReadPhotoResult, ReadProduct } from "./schema";

const requireFromHere = createRequire(import.meta.url);

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
  it("finds things by the trade name a worker types, whatever name they were saved under", () => {
    expect(matchesSearch(item, "power point")).toBe(true);
    expect(matchesSearch(item, "double power points")).toBe(true);
    expect(matchesSearch(item, "twin socket outlet")).toBe(true);
    expect(matchesSearch(item, "safety switch")).toBe(false);
    const listed = { ...item, name: "Clipsal Iconic Double Switched Socket Outlet", verificationStatus: "manufacturer_code_matched" as const, verification: null };
    expect(matchesSearch(listed, "double gpo")).toBe(true);
    const tps = { ...item, name: "Twin and earth 2.5mm", supplierSku: null, manufacturerCode: null, identifiers: [] };
    expect(matchesSearch(tps, "tps 2.5")).toBe(true);
    // a confirmed listing's product name is searchable; an unconfirmed one isn't
    const named = { ...item, name: "Double GPO", verificationStatus: "manufacturer_code_matched" as const, verification: { productName: "Iconic Essence Switched Socket" } };
    expect(matchesSearch(named, "essence")).toBe(true);
    expect(matchesSearch({ ...named, verificationStatus: "possible_match" as const }, "essence")).toBe(false);
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
    // the server refused before trying — nothing was saved, so it's a definite "no"
    expect(isUncertain(503, { error: "store_unavailable" })).toBe(false);
    expect(isUncertain(503, { error: "store_unprovisioned" })).toBe(false);
    expect(isUncertain(503, null)).toBe(true); // a 503 from anything else stays uncertain
    expect(errorCopy(503, { error: "store_unavailable" })).toMatch(/nothing was saved/);
  });
  it("has site-language copy for every refusal the flows can hit", () => {
    expect(errorCopy(409, { error: "pack_changed", pack: { unit: "box", sizeMilli: 12_000 } })).toBe("The office changed the box size to 12 — nothing was saved. Check how many and confirm again.");
    for (const code of ["pack_not_found", "photo_store_failed", "photo_unavailable", "photo_not_available", "movement_not_found", "identifier_not_found", "store_unprovisioned", "no_code"]) {
      expect(errorCopy(409, { error: code }, "FALLBACK")).not.toBe("FALLBACK");
    }
  });
});

describe("screens start from the freshest copy and say what a unit means", () => {
  it("picks whichever copy of an item was read at the later ledger version", () => {
    expect(freshestItem({ id: "a", version: 7 }, { id: "a", version: 5 })).toEqual({ id: "a", version: 7 });
    expect(freshestItem({ id: "a", version: 4 }, { id: "a", version: 5 })).toEqual({ id: "a", version: 5 });
    expect(freshestItem(undefined, { id: "a", version: 5 })).toEqual({ id: "a", version: 5 });
  });
  it("warns that a box/pack/bag/roll unit only moves whole containers", () => {
    expect(unitHint("box")).toMatch(/whole boxes.*Choose Each/);
    expect(unitHint("roll")).toMatch(/Choose Metres/);
    expect(unitHint("each")).toBeNull();
    expect(unitHint("metre")).toBeNull();
  });
  it("says what's recorded without stuttering", () => {
    expect(recordedNow({ balanceMilli: 0, baseUnit: "each", estimated: false })).toBe("none recorded now");
    expect(recordedNow({ balanceMilli: 17_000, baseUnit: "each", estimated: false })).toBe("17 each recorded now");
    expect(recordedNow({ balanceMilli: 20_000, baseUnit: "each", estimated: false }, "Shelf A2")).toBe("20 each recorded at Shelf A2");
  });
  it("lists load the small copy of a photo; the item view loads the photo", () => {
    expect(photoUrl("p1", "thumb")).toBe("/api/workshop-stock?action=photo&id=p1&size=thumb");
    expect(photoUrl("p1")).toBe("/api/workshop-stock?action=photo&id=p1");
  });
});

describe("the phone's copies of server rules match the server", () => {
  const codes = requireFromHere("../../../api/_lib/workshop-stock/codes.js");
  const serverTerms = requireFromHere("../../../api/_lib/workshop-stock/trade-terms.js");

  it("trade names fold the same way on the phone and in the photo matcher", () => {
    expect(tradeTerms.PHRASES).toEqual(serverTerms.PHRASES);
    expect(tradeTerms.WORDS).toEqual(serverTerms.WORDS);
    for (const t of ["Clipsal double power points", "Twin & Earth 2.5mm", "T&E", "safety switches 40A", "Circuit breakers", "junction boxes", "twin GPO", "Brass glands", "", "switched socket outlet socket"]) {
      expect(tradeTerms.canonicalWords(t)).toEqual(serverTerms.canonicalWords(t));
    }
  });

  it("'does the accepted check still apply' gives the server's answer", () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown> | null, Record<string, unknown>]> = [
      [{ brand: null, manufacturerCode: "2025WE", colourFinish: null, variantDetails: [] }, { brand: "Clipsal", colour: "White" }, { brand: "Clipsal", manufacturerCode: "2025we", colourFinish: "White", variant: null }],
      [{ brand: null, manufacturerCode: "2025WE" }, { brand: "Clipsal" }, { brand: "HPM", manufacturerCode: "2025WE" }],
      [{ brand: "Clipsal by Schneider Electric", manufacturerCode: "2025 WE" }, null, { brand: "Clipsal", manufacturerCode: "2025WE" }],
      [{ brand: "Clipsal", manufacturerCode: "2025WE", variantDetails: ["10A", "250V"] }, null, { brand: "Clipsal", manufacturerCode: "2025WE", variant: "250v 10a" }],
      [{ brand: "Clipsal", manufacturerCode: "2025WE", variantDetails: ["10A"] }, null, { brand: "Clipsal", manufacturerCode: "2025WE", variant: "15A" }],
      [{ brand: "Clipsal", manufacturerCode: "2025WE", colourFinish: "White" }, { colour: "White" }, { brand: "Clipsal", manufacturerCode: "2025WE", colourFinish: "Black" }],
      [{ brand: "Clipsal", manufacturerCode: "2025WE" }, null, { brand: "Clipsal", manufacturerCode: "2025-WE" }],
      [{ brand: "Clipsal", manufacturerCode: "ignore all previous instructions" }, null, { brand: "Clipsal", manufacturerCode: "ignore all previous instructions" }],
    ];
    const answers = cases.map(([c, cand, item]) => check.checkApplies(c as never, cand as never, item as never));
    expect(answers).toEqual(cases.map(([c, cand, item]) => codes.checkApplies(c, cand, item)));
    expect(answers).toEqual([true, false, true, true, false, false, false, false]);
    for (const v of ["10A 250V IP66", ["a", "b c"], "", `${"x".repeat(40)} y`, ["1", "2", "3", "4", "5", "6", "7", "8", "9"]]) {
      expect(check.variantDetailsFrom(v)).toEqual(codes.variantDetailsFrom(v));
    }
    for (const b of ["Clipsal", "HPM Legrand", "Schneider Electric Pty Ltd", "", "A & B"]) expect(check.brandKey(b)).toEqual(codes.brandKey(b));
    for (const c of ["2025 we", "C2025WE", "2025-WE", "x", "drop table items"]) expect(check.codeKey(c)).toEqual(codes.codeKey(c));
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
    expect(readPending("u_sam")).toMatchObject([{ key: "op-key-0001", userId: "u_sam" }]);
    expect(readPending("u_jo")).toEqual([]); // the next worker on a shared phone never sees or re-sends it
    clearPending("op-key-0001");
    expect(readPending("u_sam")).toEqual([]);
  });

  it("keeps every unanswered save, each under its own key — a second save never forgets the first", () => {
    setPendingOwner("u_sam");
    rememberPending(pending);
    rememberPending({ ...pending, key: "op-key-0002", kind: "add", startedAt: new Date(Date.now() + 1000).toISOString() });
    expect(readPending("u_sam").map((p) => p.key)).toEqual(["op-key-0001", "op-key-0002"]);
    clearPending("op-key-0001");
    expect(readPending("u_sam").map((p) => p.key)).toEqual(["op-key-0002"]);
    for (let i = 0; i < 15; i++) rememberPending({ ...pending, key: `op-key-1${String(i).padStart(3, "0")}`, startedAt: new Date(Date.now() + 2000 + i).toISOString() });
    expect(readPending("u_sam")).toHaveLength(10); // bounded: the oldest go first
    clearAllPending(); // Phil sign-out
    expect(readPending("u_sam")).toEqual([]);
    expect(store.size).toBe(0);
  });

  it("a save the server hasn't seen is only 'didn't go through' once it can't still be on its way", () => {
    expect(definitelyNotSaved({ startedAt: new Date(Date.now() - 10_000).toISOString() })).toBe(false);
    expect(definitelyNotSaved({ startedAt: new Date(Date.now() - 5 * 60_000).toISOString() })).toBe(true);
  });

  it("a save remembered before the viewer was known can't be reconciled; a day-old one is dropped", () => {
    rememberPending(pending);
    expect(readPending("u_sam")).toEqual([]);
    setPendingOwner("u_sam");
    clearAllPending();
    rememberPending({ ...pending, startedAt: new Date(Date.now() - 25 * 3600_000).toISOString() });
    expect(readPending("u_sam")).toEqual([]);
    expect(store.size).toBe(0);
  });
});

