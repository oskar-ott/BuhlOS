import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  blankLine,
  blankNote,
  buildItemisedInput,
  buildLabourLines,
  buildMaterialLines,
  dayRange,
  draftAmountCents,
  draftRefKeys,
  draftSummary,
  draftsFromItems,
  formatHours,
  lineAmountCents,
  marginOf,
  materialsOf,
  milliToInput,
  parseMarkupToBp,
  parseQuantityToMilli,
  parseUnitPriceToCents,
  roundUpMilli,
  unitPriceToInput,
  withMarkup,
  type ItemDraft,
} from "./itemised";
import type { BillableDay, BillableResponse } from "./schema";

/**
 * The itemised-invoice editor's logic (#1161 / #1162): quantity × unit price
 * to the cent, hours and materials turned into lines, markup and margin. Every
 * figure here must agree with the server's own maths, so the two are compared
 * directly.
 */
const requireFromHere = createRequire(import.meta.url);
const A = requireFromHere("../../../api/_lib/customer-invoices/amounts.js");

const line = (over: Partial<ItemDraft> = {}): ItemDraft => ({ ...blankLine(), description: "Line", quantity: "1", price: "10", ...over });
const form = (items: ItemDraft[], over: Record<string, unknown> = {}) =>
  buildItemisedInput({ title: "Shop front rewire", items, plannedDate: "", retentionBp: null, note: null, ...over });

describe("quantity × unit price", () => {
  it("is worked out in whole thousandths and cents, rounded once", () => {
    expect(lineAmountCents(1000, 9500)).toBe(9500); // 1 × $95.00
    expect(lineAmountCents(14350, 9500)).toBe(136325); // 14.35 h × $95.00
    expect(lineAmountCents(2500, 3333)).toBe(8333); // 2.5 × $33.33 = 83.325 → $83.33 (half goes up)
    expect(lineAmountCents(333, 100)).toBe(33); // 0.333 × $1.00 = 33.3c
    expect(lineAmountCents(1000, 0)).toBe(0);
  });

  it("rounds a discount the same way as a charge (away from zero)", () => {
    expect(lineAmountCents(2500, -3333)).toBe(-8333);
    expect(lineAmountCents(1000, -5000)).toBe(-5000);
    expect(Object.is(lineAmountCents(1000, -0), 0)).toBe(true);
  });

  it("refuses figures it can't price rather than guessing", () => {
    expect(lineAmountCents(0, 100)).toBeNull();
    expect(lineAmountCents(-1000, 100)).toBeNull();
    expect(lineAmountCents(1.5, 100)).toBeNull();
    expect(lineAmountCents(1000, 10.5)).toBeNull();
    expect(lineAmountCents(100_000_001, 100)).toBeNull();
    expect(lineAmountCents(1000, 10_000_001)).toBeNull();
  });

  it("agrees with the server on every case, including the half-cent ones", () => {
    const cases: Array<[number, number]> = [[1000, 9500], [14350, 9500], [2500, 3333], [2500, -3333], [333, 100], [1, 1], [1, 499], [1, 500], [999, 12345], [100_000_000, 10_000_000], [0, 5], [5, 20_000_000]];
    for (const [q, u] of cases) {
      expect(lineAmountCents(q, u)).toBe(A.lineAmountCents(q, u));
    }
  });
});

describe("typing a quantity and a price", () => {
  it("reads a quantity to three decimals and refuses a typo", () => {
    expect(parseQuantityToMilli("2.5")).toBe(2500);
    expect(parseQuantityToMilli("14.35")).toBe(14350);
    expect(parseQuantityToMilli("1,250")).toBe(1_250_000);
    expect(parseQuantityToMilli("0.001")).toBe(1);
    expect(parseQuantityToMilli("0")).toBeNull();
    expect(parseQuantityToMilli("1.2345")).toBeNull();
    expect(parseQuantityToMilli("-1")).toBeNull();
    expect(parseQuantityToMilli("two")).toBeNull();
    expect(parseQuantityToMilli("")).toBeNull();
  });

  it("shows a quantity back without trailing zeros", () => {
    expect(milliToInput(2500)).toBe("2.5");
    expect(milliToInput(1000)).toBe("1");
    expect(milliToInput(12750)).toBe("12.75");
    expect(milliToInput(1)).toBe("0.001");
    expect(milliToInput(null)).toBe("");
  });

  it("a unit price may be negative (a discount) or zero (listed at no charge)", () => {
    expect(parseUnitPriceToCents("95")).toBe(9500);
    expect(parseUnitPriceToCents("$1,250.50")).toBe(125050);
    expect(parseUnitPriceToCents("-50")).toBe(-5000);
    expect(parseUnitPriceToCents("-$50.25")).toBe(-5025);
    expect(parseUnitPriceToCents("0")).toBe(0);
    expect(Object.is(parseUnitPriceToCents("-0"), 0)).toBe(true);
    expect(parseUnitPriceToCents("9.999")).toBeNull();
    expect(parseUnitPriceToCents("abc")).toBeNull();
    expect(parseUnitPriceToCents("")).toBeNull();
    expect(parseUnitPriceToCents("100001")).toBeNull();
    expect(unitPriceToInput(-5000)).toBe("-50.00");
    expect(unitPriceToInput(9550)).toBe("95.50");
  });
});

describe("markup and margin", () => {
  it("a markup is added to cost and rounded once", () => {
    expect(withMarkup(18500, 2500)).toBe(23125); // $185.00 + 25%
    expect(withMarkup(7440, 2500)).toBe(9300);
    expect(withMarkup(3460, 2500)).toBe(4325);
    expect(withMarkup(100, 0)).toBe(100); // at cost
    expect(withMarkup(333, 3333)).toBe(444); // 3.33 × 1.3333 = 4.4399…
    expect(withMarkup(-1000, 2500)).toBe(-1250); // a supplier credit passes through marked up
  });

  it("a markup can be well over 100%, a percentage of something cannot", () => {
    expect(parseMarkupToBp("25")).toBe(2500);
    expect(parseMarkupToBp("12.5%")).toBe(1250);
    expect(parseMarkupToBp("0")).toBe(0);
    expect(parseMarkupToBp("150")).toBe(15000);
    expect(parseMarkupToBp("1000")).toBe(100000);
    expect(parseMarkupToBp("1001")).toBeNull();
    expect(parseMarkupToBp("-5")).toBeNull();
    expect(parseMarkupToBp("")).toBeNull();
    expect(parseMarkupToBp("a lot")).toBeNull();
  });

  it("margin is a share of the SALE, so a 30% markup is a 23% margin", () => {
    const sell = withMarkup(10000, 3000);
    expect(marginOf(sell, 10000)).toEqual({ marginCents: 3000, marginBp: 2308 });
    expect(marginOf(0, 500)).toEqual({ marginCents: -500, marginBp: null });
    expect(marginOf(10000, 12000)).toEqual({ marginCents: -2000, marginBp: -2000 });
  });
});

describe("the form → what is sent", () => {
  it("sends each charge with its quantity, unit and price, and notes as wording", () => {
    const built = form([
      { ...blankNote(), description: "  Rewired the shop front.  " },
      line({ description: "Call-out fee", unit: "ea", price: "95" }),
      line({ description: "Labour", quantity: "2.5", unit: "hr", price: "95.50" }),
      line({ description: "Discount", price: "-20" }),
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.totalCents).toBe(9500 + 23875 - 2000);
    expect(built.input).toEqual({
      kind: "itemised",
      title: "Shop front rewire",
      retentionBp: null,
      plannedDate: null,
      note: null,
      items: [
        { type: "note", description: "Rewired the shop front." },
        { type: "line", description: "Call-out fee", quantityMilli: 1000, unit: "ea", unitCents: 9500, source: "manual" },
        { type: "line", description: "Labour", quantityMilli: 2500, unit: "hr", unitCents: 9550, source: "manual" },
        { type: "line", description: "Discount", quantityMilli: 1000, unit: null, unitCents: -2000, source: "manual" },
      ],
    });
  });

  it("keeps a stored line's id, and what a pulled line bills", () => {
    const built = form([
      line({ id: "it_1", description: "Labour: Sam", quantity: "4.5", unit: "hr", price: "95", source: "labour", refs: [{ t: "h", u: "u1", d: "2026-11-10", m: 4500 }] }),
    ]);
    expect(built.ok && built.input.items[0]).toEqual({
      id: "it_1", type: "line", description: "Labour: Sam", quantityMilli: 4500, unit: "hr", unitCents: 9500, source: "labour",
      refs: [{ t: "h", u: "u1", d: "2026-11-10", m: 4500 }],
    });
  });

  it("never sends a cost: the server works that out for itself", () => {
    const built = form([line({ description: "GPO", source: "material", refs: [{ t: "sl", id: "l1" }], costCents: 7440 })]);
    expect(JSON.stringify(built)).not.toContain("costCents");
  });

  it("drops rows nobody touched, but not a pulled line", () => {
    const built = form([blankLine(), blankNote(), line({ description: "One" }), { ...blankLine(), refs: [{ t: "ml", id: "x" }], description: "Docket", price: "5" }]);
    expect(built.ok && built.input.items.map((i) => i.description)).toEqual(["One", "Docket"]);
  });

  it.each([
    ["no heading", { title: "  " }, [line()], "title", "Say what the work was."],
    ["a heading that is too long", { title: "x".repeat(201) }, [line()], "title", "Keep it under 200 characters."],
    ["nothing with a price", {}, [{ ...blankNote(), description: "Just words" }], "items", "Add at least one line with a price."],
    ["a line with no description", {}, [line({ description: "", price: "5" })], "items", "Each line needs a description."],
    ["a quantity that isn't one", {}, [line({ description: "Cable", quantity: "lots" })], "items", 'Enter a quantity for "Cable", e.g. 1 or 2.5.'],
    ["a price that isn't one", {}, [line({ description: "Cable", price: "cheap" })], "items", 'Enter a price for "Cable" in dollars, e.g. 95 or 95.50.'],
    ["a unit that is a sentence", {}, [line({ unit: "per linear metre" })], "items", "Keep the unit short, e.g. hr, m or ea."],
    ["lines that cancel out", {}, [line({ price: "50" }), line({ description: "Credit", price: "-50" })], "items", "The lines need to add up to more than $0."],
    ["a bad date", { plannedDate: "soon" }, [line()], "plannedDate", "Pick a valid date."],
  ])("refuses %s, naming it", (_name, over, items, field, message) => {
    const built = form(items as ItemDraft[], over);
    expect(built).toMatchObject({ ok: false, field, message });
  });

  it("says which row is wrong, so the editor can mark it", () => {
    const bad = line({ description: "Cable", price: "cheap" });
    const built = form([line(), bad]);
    expect(built).toMatchObject({ ok: false, key: bad.key });
  });

  it("refuses more lines than an invoice can hold", () => {
    const built = form(Array.from({ length: 101 }, (_, i) => line({ description: `Line ${i}` })));
    expect(built).toMatchObject({ ok: false, message: "An invoice can have up to 100 lines." });
  });
});

describe("what the rows add up to, and what they cost", () => {
  it("adds the charges and, apart, the cost of the lines that have one", () => {
    const s = draftSummary([
      line({ price: "95" }), // typed, no cost: not part of the margin
      line({ quantity: "14.35", price: "95", source: "labour", refs: [{ t: "h", u: "u", d: "2026-11-10", m: 14350 }], costCents: 68880 }),
      line({ quantity: "6", price: "15.50", source: "material", refs: [{ t: "sl", id: "l" }], costCents: 7440 }),
      { ...blankNote(), description: "words" },
      line({ price: "oops" }), // not priced yet: ignored
    ]);
    expect(s).toEqual({ totalCents: 9500 + 136325 + 9300, pricedCount: 3, costCents: 76320, costedSellCents: 145625, costKnown: true });
  });

  it("says the cost isn't known when a pulled line has none, rather than understating it", () => {
    const s = draftSummary([line({ source: "labour", refs: [{ t: "h", u: "u", d: "2026-11-10", m: 1000 }], costCents: null })]);
    expect(s.costKnown).toBe(false);
  });

  it("a row's own total follows its quantity and price", () => {
    expect(draftAmountCents(line({ quantity: "2.5", price: "33.33" }))).toBe(8333);
    expect(draftAmountCents(line({ quantity: "", price: "5" }))).toBeNull();
    expect(draftAmountCents({ ...blankNote(), description: "x" })).toBeNull();
  });
});

describe("a stored invoice back into the editor", () => {
  it("round-trips: load, save unchanged, and the same lines come out", () => {
    const stored = [
      { id: "n1", type: "note" as const, description: "Words" },
      { id: "a", type: "line" as const, description: "Labour", quantityMilli: 14350, unit: "hr", unitCents: 9500, amountCents: 136325, source: "labour" as const, costCents: 68880, refs: [{ t: "h" as const, u: "u", d: "2026-11-10", m: 14350 }] },
      { id: "b", type: "line" as const, description: "Credit", quantityMilli: 1000, unit: null, unitCents: -5000, amountCents: -5000, source: "manual" as const, costCents: null, refs: [] },
    ];
    const drafts = draftsFromItems(stored);
    expect(drafts.map((d) => [d.quantity, d.unit, d.price])).toEqual([["", "", ""], ["14.35", "hr", "95.00"], ["1", "", "-50.00"]]);
    const built = form(drafts);
    expect(built.ok && built.input.items).toEqual([
      { id: "n1", type: "note", description: "Words" },
      { id: "a", type: "line", description: "Labour", quantityMilli: 14350, unit: "hr", unitCents: 9500, source: "labour", refs: stored[1]!.refs },
      { id: "b", type: "line", description: "Credit", quantityMilli: 1000, unit: null, unitCents: -5000, source: "manual" },
    ]);
  });
});

// ── hours ───────────────────────────────────────────────────────────────────

const day = (userId: string, name: string, date: string, unbilledMilli: number, over: Partial<BillableDay> = {}): BillableDay => ({
  userId, name, date, hoursMilli: unbilledMilli, billedMilli: 0, unbilledMilli, onInvoice: null,
  chargeOutRateCents: 9500, costRateCents: 4800, hasCostRate: true, ...over,
});
const DAYS = [
  day("sam", "Sam Sparky", "2026-11-10", 4500),
  day("sam", "Sam Sparky", "2026-11-11", 7600),
  day("sam", "Sam Sparky", "2026-11-12", 2250),
  day("dy", "Dylan Sinclair", "2026-11-11", 3000, { chargeOutRateCents: null, costRateCents: 5200 }),
];

describe("hours → invoice lines", () => {
  it("one line per worker, with the days it covers and what they cost", () => {
    const lines = buildLabourLines(DAYS, { groupBy: "worker", roundMinutes: 0, rates: { sam: 9500, dy: 9000 } });
    expect(lines.map((l) => [l.description, l.quantity, l.unit, l.price, l.costCents])).toEqual([
      ["Labour: Sam Sparky, 10 Nov 2026 to 12 Nov 2026", "14.35", "hr", "95.00", 68880],
      ["Labour: Dylan Sinclair, 11 Nov 2026", "3", "hr", "90.00", 15600],
    ]);
    expect(lines[0]!.refs).toEqual([
      { t: "h", u: "sam", d: "2026-11-10", m: 4500 },
      { t: "h", u: "sam", d: "2026-11-11", m: 7600 },
      { t: "h", u: "sam", d: "2026-11-12", m: 2250 },
    ]);
    expect(lines.every((l) => l.source === "labour")).toBe(true);
  });

  it("a worker with no rate gets a blank price to fill in, never a guessed one", () => {
    const lines = buildLabourLines(DAYS, { groupBy: "worker", roundMinutes: 0, rates: { sam: 9500, dy: null } });
    expect(lines[1]!.price).toBe("");
    expect(draftAmountCents(lines[1]!)).toBeNull();
  });

  it("one line per rate puts workers on the same price together and names nobody", () => {
    const same = buildLabourLines(DAYS, { groupBy: "rate", roundMinutes: 0, rates: { sam: 9500, dy: 9500 } });
    expect(same).toHaveLength(1);
    expect(same[0]).toMatchObject({ description: "Labour, 10 Nov 2026 to 12 Nov 2026", quantity: "17.35", price: "95.00", costCents: 84480 });
    expect(same[0]!.refs).toHaveLength(4);
    const split = buildLabourLines(DAYS, { groupBy: "rate", roundMinutes: 0, rates: { sam: 9500, dy: 9000 } });
    expect(split.map((l) => [l.quantity, l.price])).toEqual([["14.35", "95.00"], ["3", "90.00"]]);
  });

  it("rounds each line UP to the step — and still bills the hours as logged", () => {
    const lines = buildLabourLines(DAYS, { groupBy: "worker", roundMinutes: 30, rates: { sam: 9500, dy: 9000 } });
    expect(lines[0]!.quantity).toBe("14.5");
    expect(lines[1]!.quantity).toBe("3"); // already on the step
    // what is marked as billed is the hours logged, not the rounded figure
    expect(lines[0]!.refs.reduce((s, r) => s + (r.t === "h" ? r.m : 0), 0)).toBe(14350);
    expect(roundUpMilli(14350, 15)).toBe(14500);
    expect(roundUpMilli(14350, 60)).toBe(15000);
    expect(roundUpMilli(14350, 0)).toBe(14350);
    expect(roundUpMilli(1, 15)).toBe(250);
  });

  it("leaves out days with nothing unbilled, and a cost when a day has no cost rate", () => {
    const lines = buildLabourLines(
      [day("sam", "Sam Sparky", "2026-11-10", 0), day("sam", "Sam Sparky", "2026-11-11", 2000, { costRateCents: null, hasCostRate: false })],
      { groupBy: "worker", roundMinutes: 0, rates: { sam: 9500 } }
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!).toMatchObject({ quantity: "2", costCents: null });
    expect(lines[0]!.refs).toEqual([{ t: "h", u: "sam", d: "2026-11-11", m: 2000 }]);
  });

  it("says a range of days plainly", () => {
    expect(dayRange(["2026-11-12", "2026-11-10"])).toBe("10 Nov 2026 to 12 Nov 2026");
    expect(dayRange(["2026-11-10"])).toBe("10 Nov 2026");
    expect(dayRange([])).toBe("");
    expect(formatHours(14350)).toBe("14.35 h");
  });
});

// ── materials ───────────────────────────────────────────────────────────────

const BILLABLE = {
  supplier: {
    available: true, reason: null,
    lines: [
      { id: "l1", invoiceId: "i1", supplier: "Rexel Norwood", number: "RX-1", date: "2026-11-10", description: "2.5mm TPS twin & earth", quantity: 100, unit: "m", unitCostCents: 185, costCents: 18500, onInvoice: null },
      { id: "l2", invoiceId: "i1", supplier: "Rexel Norwood", number: "RX-1", date: "2026-11-10", description: "Double GPO 10A white", quantity: 6, unit: "ea", unitCostCents: 1240, costCents: 7440, onInvoice: "IV7001-1" },
    ],
    whole: [{ id: "i2", invoiceId: "i2", supplier: "MMEM Kent Town", number: "MM-9", date: "2026-11-12", costCents: 12000, lineCount: 1, onInvoice: null }],
  },
  ledger: { available: true, reason: null, lines: [{ id: "ml_1", supplier: "Bunnings", number: "D-88", date: "2026-11-11", description: null, costCents: 3460, onInvoice: null }] },
} as unknown as BillableResponse;

describe("materials → invoice lines", () => {
  const all = materialsOf(BILLABLE);

  it("lists every material from every source, oldest first, with what bills it", () => {
    expect(all.map((m) => [m.refKey, m.description, m.costCents, m.onInvoice])).toEqual([
      ["sl:l1", "2.5mm TPS twin & earth", 18500, null],
      ["sl:l2", "Double GPO 10A white", 7440, "IV7001-1"],
      ["ml:ml_1", "Materials", 3460, null],
      ["si:i2", "Materials", 12000, null],
    ]);
  });

  it("never puts the wholesaler's name on the client's invoice by default", () => {
    const lines = buildMaterialLines(all, { markupBp: 2500, mode: "each" });
    expect(lines.map((l) => l.description).join(" ")).not.toMatch(/Rexel|MMEM|Bunnings|RX-1|MM-9/);
  });

  it("each item: cost plus the markup, with the supplier's quantity when it divides to a whole cent", () => {
    const lines = buildMaterialLines(all, { markupBp: 2500, mode: "each" });
    expect(lines.map((l) => [l.description, l.quantity, l.unit, l.price, l.costCents])).toEqual([
      // 231.25 / 100 m is not a whole cent → one item, so the total is exactly cost + 25%
      ["2.5mm TPS twin & earth (100 m)", "1", "", "231.25", 18500],
      ["Double GPO 10A white", "6", "ea", "15.50", 7440],
      ["Materials", "1", "", "43.25", 3460],
      ["Materials", "1", "", "150.00", 12000],
    ]);
    // every line comes to exactly its cost plus the markup
    for (const [i, m] of all.entries()) expect(draftAmountCents(lines[i]!)).toBe(withMarkup(m.costCents, 2500));
    expect(lines.map((l) => l.refs)).toEqual([[{ t: "sl", id: "l1" }], [{ t: "sl", id: "l2" }], [{ t: "ml", id: "ml_1" }], [{ t: "si", id: "i2" }]]);
  });

  it("one Materials line for the lot, billing every item", () => {
    const [one, ...rest] = buildMaterialLines(all, { markupBp: 2500, mode: "one" });
    expect(rest).toEqual([]);
    expect(one).toMatchObject({ description: "Materials", quantity: "1", price: "517.50", costCents: 41400, source: "material" });
    expect(one!.refs).toHaveLength(4);
  });

  it("at cost when the markup is 0, and nothing at all when nothing is chosen", () => {
    expect(buildMaterialLines(all.slice(1, 2), { markupBp: 0, mode: "each" })[0]).toMatchObject({ quantity: "6", price: "12.40" });
    expect(buildMaterialLines([], { markupBp: 2500, mode: "one" })).toEqual([]);
  });

  it("knows what the draft's own rows already bill", () => {
    const keys = draftRefKeys([
      ...buildMaterialLines(all.slice(0, 1), { markupBp: 0, mode: "each" }),
      ...buildLabourLines(DAYS.slice(0, 1), { groupBy: "worker", roundMinutes: 0, rates: {} }),
    ]);
    expect([...keys].sort()).toEqual(["h:sam|2026-11-10", "sl:l1"]);
  });
});
