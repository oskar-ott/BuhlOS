import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

/**
 * api/_lib/customer-invoices/billable.js (#1162) — what on a job can go on an
 * invoice, and the rule everything here defends: NOTHING IS BILLED TWICE.
 * "Billed" is read from the invoices' own lines, so it can't drift from them.
 */
const requireFromHere = createRequire(import.meta.url);
const B = requireFromHere("../../../api/_lib/customer-invoices/billable.js");

type Ref = Record<string, unknown>;
const line = (refs: Ref[], over: Record<string, unknown> = {}) => ({
  id: "it", type: "line", description: "Line", quantityMilli: 1000, unit: null, unitCents: 100, ...over, refs,
});
const invoice = (id: string, items: unknown[], over: Record<string, unknown> = {}) => ({
  id, kind: "itemised", title: `Invoice ${id}`, state: "planned", invoiceNumber: null, xeroStatus: null, extraLines: [], items, ...over,
});
const h = (u: string, d: string, m: number) => ({ t: "h", u, d, m });

const SOURCES = {
  labour: {
    available: true, reason: null, pendingMilli: 1500,
    days: [
      { userId: "sam", name: "Sam Sparky", date: "2026-11-10", milli: 4500, costRateCents: 4800, chargeOutRateCents: 9500 },
      { userId: "sam", name: "Sam Sparky", date: "2026-11-11", milli: 7600, costRateCents: 4800, chargeOutRateCents: 9500 },
      { userId: "dy", name: "Dylan Sinclair", date: "2026-11-11", milli: 3000, costRateCents: null, chargeOutRateCents: null },
    ],
  },
  supplier: {
    available: true, reason: null,
    lines: [{ id: "l1", invoiceId: "i1", supplier: "Rexel", number: "RX-1", date: "2026-11-10", description: "GPO", quantity: 6, unit: "ea", unitCostCents: 1240, costCents: 7440 }],
    whole: [{ id: "i2", invoiceId: "i2", supplier: "MMEM", number: "MM-9", date: "2026-11-12", costCents: 12000, lineCount: 1 }],
  },
  ledger: { available: true, reason: null, lines: [{ id: "ml_1", date: "2026-11-11", supplier: "Bunnings", description: "Saddles", number: null, costCents: 3460 }] },
};
const VARIATIONS = [
  { id: "v1", status: "approved", approvedCents: 110000 },
  { id: "v2", status: "proposed", approvedCents: null },
];
const resolve = (items: unknown[], rows: unknown[] = [], over: Record<string, unknown> = {}) =>
  B.resolveItems({ items, sources: SOURCES, rows, variations: VARIATIONS, ...over });
const refusal = (fn: () => unknown) => {
  try { fn(); } catch (e) { return { code: (e as { code: string }).code, ...(e as { extra: object }).extra }; }
  return null;
};

describe("which invoices hold what they billed", () => {
  it.each([
    ["planned", { state: "planned" }, true],
    ["mid-send", { state: "sending" }, true],
    ["failed, still to be retried", { state: "failed" }, true],
    ["a draft in Xero", { state: "sent", xeroStatus: "DRAFT" }, true],
    ["paid", { state: "sent", xeroStatus: "PAID" }, true],
    ["cancelled", { state: "cancelled" }, false],
    ["deleted in Xero", { state: "sent", xeroStatus: "DELETED" }, false],
    ["voided in Xero", { state: "sent", xeroStatus: "VOIDED" }, false],
  ])("%s → %s", (_name, over, holds) => {
    expect(B.holdsItsRefs(invoice("a", [], over))).toBe(holds);
  });
});

describe("what is already on an invoice", () => {
  const rows = [
    invoice("a", [line([h("sam", "2026-11-10", 4500)]), line([{ t: "sl", id: "l1" }])], { invoiceNumber: "IV7001-1", state: "sent", xeroStatus: "DRAFT" }),
    invoice("b", [line([{ t: "ml", id: "ml_1" }])], { state: "sent", xeroStatus: "DELETED", invoiceNumber: "IV7001-2" }),
    { id: "c", kind: "stage", title: "Rough-in", state: "planned", items: [], extraLines: [{ description: "V1", amountCents: 110000, variationId: "v1" }] },
  ];

  it("reads it from the lines of the invoices that still hold them", () => {
    const idx = B.billedIndex(rows);
    expect(idx.hours.get("sam|2026-11-10")).toBe(4500);
    expect(idx.ids.get("sl:l1")).toBe("IV7001-1");
    expect(idx.ids.get("v:v1")).toBe("Rough-in"); // a stage's extra line
    expect(idx.ids.has("ml:ml_1")).toBe(false); // that invoice was deleted in Xero
  });

  it("the invoice being edited doesn't count against itself", () => {
    const idx = B.billedIndex(rows, { excludeInvoiceId: "a" });
    expect(idx.hours.size).toBe(0);
    expect(idx.ids.has("sl:l1")).toBe(false);
  });

  it("marks every source for the picker, and adds up what is left", () => {
    const p = B.present(SOURCES, rows);
    expect(p.labour.days.map((d: { unbilledMilli: number; onInvoice: string | null }) => [d.unbilledMilli, d.onInvoice])).toEqual([[0, "IV7001-1"], [7600, null], [3000, null]]);
    expect(p.labour.pendingMilli).toBe(1500);
    expect(p.supplier.lines[0].onInvoice).toBe("IV7001-1");
    expect(p.ledger.lines[0].onInvoice).toBeNull();
    expect(p.summary).toEqual({ unbilledHoursMilli: 10600, unbilledMaterialCount: 2, unbilledMaterialCostCents: 15460, anyBilled: true });
  });

  it("hours cut back after they were billed never show as negative", () => {
    const p = B.present(SOURCES, [invoice("a", [line([h("sam", "2026-11-10", 6000)])])]);
    expect(p.labour.days[0]).toMatchObject({ billedMilli: 4500, unbilledMilli: 0 });
  });

  it("hours ADDED after they were billed show as not yet on an invoice", () => {
    const p = B.present(SOURCES, [invoice("a", [line([h("sam", "2026-11-10", 3000)])])]);
    expect(p.labour.days[0]).toMatchObject({ billedMilli: 3000, unbilledMilli: 1500 });
  });

  it("says nothing has been billed from the job's data when only a variation has", () => {
    expect(B.present(SOURCES, [rows[2]]).summary.anyBilled).toBe(false);
  });

  it("which invoice each variation is on", () => {
    expect([...B.variationBilling(rows)]).toEqual([["v1", "Rough-in"]]);
  });
});

describe("checking an invoice's lines against the job", () => {
  it("works the cost out from the job's own data — never from the browser", () => {
    const out = resolve([
      line([h("sam", "2026-11-10", 4500), h("sam", "2026-11-11", 7600)], { costCents: 1, source: "manual" }),
      line([{ t: "sl", id: "l1" }, { t: "ml", id: "ml_1" }], { costCents: 999999 }),
      line([{ t: "si", id: "i2" }]),
    ]);
    // 12.1 h × $48.00 = $580.80
    expect(out.map((i: { source: string; costCents: number | null }) => [i.source, i.costCents])).toEqual([["labour", 58080], ["material", 10900], ["material", 12000]]);
  });

  it("a typed line keeps the office's own cost, if they gave one", () => {
    const out = resolve([line([], { costCents: 500 }), line([]), { type: "note", id: "n", description: "Words" }]);
    expect(out.map((i: { costCents?: number | null }) => i.costCents)).toEqual([500, null, undefined]);
    expect(out[2]).toEqual({ id: "n", type: "note", description: "Words" });
  });

  it("has no cost for hours whose worker has no cost rate — the margin is then left out", () => {
    expect(resolve([line([h("dy", "2026-11-11", 3000)])])[0]).toMatchObject({ source: "labour", costCents: null });
  });

  it("refuses hours another invoice already holds, naming it", () => {
    const rows = [invoice("a", [line([h("sam", "2026-11-10", 4500)])], { invoiceNumber: "IV7001-1" })];
    expect(refusal(() => resolve([line([h("sam", "2026-11-10", 4500)])], rows))).toEqual({ code: "already_billed", what: "hours", on: "IV7001-1" });
    // the part that is left can still be billed
    expect(resolve([line([h("sam", "2026-11-11", 7600)])], rows)).toHaveLength(1);
  });

  it("refuses more hours than are left on a day, even split across invoices", () => {
    const rows = [invoice("a", [line([h("sam", "2026-11-10", 3000)])])];
    expect(refusal(() => resolve([line([h("sam", "2026-11-10", 1501)])], rows))?.code).toBe("already_billed");
    expect(resolve([line([h("sam", "2026-11-10", 1500)])], rows)).toHaveLength(1);
  });

  it("refuses the same thing on two lines of ONE invoice", () => {
    expect(refusal(() => resolve([line([{ t: "sl", id: "l1" }]), line([{ t: "sl", id: "l1" }])]))?.code).toBe("already_billed");
    expect(refusal(() => resolve([line([h("sam", "2026-11-10", 4500)]), line([h("sam", "2026-11-10", 1)])]))?.code).toBe("already_billed");
  });

  it("refuses materials another invoice holds — and frees them when that invoice is deleted in Xero", () => {
    const held = [invoice("a", [line([{ t: "sl", id: "l1" }])], { invoiceNumber: "IV7001-1", state: "sent", xeroStatus: "AUTHORISED" })];
    expect(refusal(() => resolve([line([{ t: "sl", id: "l1" }])], held))).toEqual({ code: "already_billed", what: "materials", on: "IV7001-1" });
    const dead = [{ ...held[0], xeroStatus: "DELETED" }];
    expect(resolve([line([{ t: "sl", id: "l1" }])], dead)).toHaveLength(1);
  });

  it("lets an invoice be saved again with what it already holds", () => {
    const rows = [invoice("a", [line([h("sam", "2026-11-10", 4500)])])];
    expect(resolve([line([h("sam", "2026-11-10", 4500)])], rows, { excludeInvoiceId: "a" })).toHaveLength(1);
  });

  it.each([
    ["hours that aren't on the job", [h("nobody", "2026-11-10", 1000)], "ref_not_found"],
    ["a supplier line that isn't on the job", [{ t: "sl", id: "nope" }], "ref_not_found"],
    ["hours and materials on one line", [h("sam", "2026-11-10", 4500), { t: "sl", id: "l1" }], "mixed_refs"],
    ["a made-up kind of ref", [{ t: "zz", id: "x" }], "ref_invalid"],
    ["hours with no amount", [{ t: "h", u: "sam", d: "2026-11-10", m: 0 }], "ref_invalid"],
    ["a date that isn't one", [{ t: "h", u: "sam", d: "tomorrow", m: 1000 }], "ref_invalid"],
  ])("refuses %s", (_name, refs, code) => {
    expect(refusal(() => resolve([line(refs as Ref[])]))?.code).toBe(code);
  });

  it("refuses a line it can't price", () => {
    expect(refusal(() => resolve([line([], { quantityMilli: 0 })]))?.code).toBe("line_invalid");
  });

  it("when the job's data couldn't be read, a line that bills it is refused — a typed one still goes", () => {
    expect(refusal(() => resolve([line([h("sam", "2026-11-10", 4500)])], [], { sources: null }))?.code).toBe("ref_not_found");
    expect(resolve([line([])], [], { sources: null })).toHaveLength(1);
  });

  it("only reads the job's data when a line needs it", () => {
    expect(B.needsSources([line([])])).toBe(false);
    expect(B.needsSources([line([{ t: "v", id: "v1" }])])).toBe(false);
    expect(B.needsSources([line([{ t: "ml", id: "x" }])])).toBe(true);
    expect(B.needsSources(undefined)).toBe(false);
  });
});

describe("a variation on an invoice", () => {
  const v = (id: string, over: Record<string, unknown> = {}) => line([{ t: "v", id }], { quantityMilli: 1000, unitCents: 110000, ...over });

  it("goes on at exactly what was approved", () => {
    expect(resolve([v("v1")])[0]).toMatchObject({ source: "variation", costCents: null, refs: [{ t: "v", id: "v1" }] });
    expect(refusal(() => resolve([v("v1", { unitCents: 100000 })]))?.code).toBe("variation_amount");
  });

  it("only when it is approved, and only once", () => {
    expect(refusal(() => resolve([v("v2")]))?.code).toBe("variation_not_approved");
    expect(refusal(() => resolve([v("nope")]))?.code).toBe("ref_not_found");
    const rows = [{ id: "c", kind: "stage", title: "Rough-in", state: "planned", items: [], extraLines: [{ description: "V1", amountCents: 110000, variationId: "v1" }] }];
    expect(refusal(() => resolve([v("v1")], rows))).toEqual({ code: "already_billed", what: "variation", on: "Rough-in" });
  });

  it("the same rules hold for a stage's extra line", () => {
    const check = (extraLines: unknown[], rows: unknown[] = [], excludeInvoiceId?: string) =>
      refusal(() => B.checkVariationLines({ extraLines, rows, variations: VARIATIONS, excludeInvoiceId }));
    expect(check([{ description: "V1", amountCents: 110000, variationId: "v1" }])).toBeNull();
    expect(check([{ description: "Plain line", amountCents: 5 }])).toBeNull();
    expect(check([{ description: "V1", amountCents: 100, variationId: "v1" }])?.code).toBe("variation_amount");
    expect(check([{ description: "V2", amountCents: 1, variationId: "v2" }])?.code).toBe("variation_not_approved");
    expect(check([{ description: "V1", amountCents: 110000, variationId: "v1" }, { description: "V1 again", amountCents: 110000, variationId: "v1" }])?.code).toBe("already_billed");
    const rows = [invoice("a", [line([{ t: "v", id: "v1" }])], { invoiceNumber: "IV3350-2" })];
    expect(check([{ description: "V1", amountCents: 110000, variationId: "v1" }], rows)).toMatchObject({ code: "already_billed", on: "IV3350-2" });
    expect(check([{ description: "V1", amountCents: 110000, variationId: "v1" }], rows, "a")).toBeNull();
  });
});

describe("reading the job's hours and materials", () => {
  const baseDeps = (over: Record<string, unknown> = {}) => ({
    timeEntries: async () => [
      { userId: "sam", userName: "sparky", date: "2026-11-10", status: "approved", allocations: [{ jobId: "shop", hours: 4.5 }, { jobId: "other", hours: 3 }] },
      { userId: "sam", userName: "sparky", date: "2026-11-11T00:00:00Z", status: "approved", allocations: [{ jobId: "shop", hours: 7.6 }] },
      { userId: "sam", userName: "sparky", date: "2026-11-13", status: "submitted", allocations: [{ jobId: "shop", hours: 1.5 }] },
      { userId: "sam", userName: "sparky", date: "2026-11-14", status: "draft", allocations: [{ jobId: "shop", hours: 8 }] },
      { userId: "dy", date: "2026-11-11", status: "approved", allocations: [{ jobId: "shop", hours: 3 }] },
      { userId: "dy", date: "2026-11-11", status: "approved", allocations: [{ jobId: "elsewhere", hours: 5 }] },
      null,
    ],
    costRates: async () => ({ rates: { sam: [{ costRateCents: 4800, chargeOutRateCents: 9500, effectiveFrom: "2026-01-01" }] } }),
    historyFor: (data: { rates: Record<string, unknown[]> }, id: string) => data.rates[id] || [],
    effectiveCostRate: (hist: unknown[]) => hist[0] || null,
    users: async () => ({ users: [{ id: "sam", name: "Sam Sparky" }, { id: "dy", name: "Dylan Sinclair" }], employees: [] }),
    labeller: (refs: { users: Array<{ id: string; name: string }> }) => (id: string) => refs.users.find((u) => u.id === id)?.name || id,
    supplierBreakdown: async () => ({
      lines: [
        { id: "l1", invoiceId: "i1", description: "TPS", quantity: 100, unit: "m", unitPriceCents: 185, signedCents: 18500 },
        { id: "l2", invoiceId: "i1", description: "GPO", quantity: 6, unit: "ea", unitPriceCents: 1240, signedCents: 7440 },
        { id: "l3", invoiceId: "i2", description: "A lot of conduit", quantity: 1, unit: "lot", unitPriceCents: 30000, signedCents: 30000 },
        { id: "l4", invoiceId: "i3", description: "Returned RCBO", quantity: 1, unit: "ea", unitPriceCents: 4650, signedCents: -4650 },
      ],
      invoices: [
        { invoiceId: "i1", supplierName: "Rexel", supplierInvoiceNumber: "RX-1", invoiceDate: "2026-11-10T00:00:00Z", documentType: "invoice", amountCents: 25940 },
        // split across two jobs: only $120 of the $300 is this job's
        { invoiceId: "i2", supplierName: "MMEM", supplierInvoiceNumber: "MM-9", invoiceDate: "2026-11-12", documentType: "invoice", amountCents: 12000 },
        { invoiceId: "i3", supplierName: "Rexel", supplierInvoiceNumber: "CN-4", invoiceDate: "2026-11-13", documentType: "credit_note", amountCents: -4650 },
        { invoiceId: "i4", supplierName: null, supplierInvoiceNumber: null, invoiceDate: null, documentType: "receipt", amountCents: 2200 },
      ],
    }),
    ledger: async () => ({ lines: [{ id: "ml_1", date: "2026-11-11", supplier: "Bunnings", description: null, reference: "D-88", amountCents: 3460 }] }),
    ledgerLines: (data: { lines: unknown[] }) => data.lines,
    ...over,
  });
  const load = (deps = baseDeps(), flags = { supplierInvoices: true, ledger: true }) =>
    B.loadSources({ job: { id: "shop" }, sql: {}, tenantId: "t1", flags, deps });

  it("approved hours on THIS job, by worker and day, with the rate that applied", async () => {
    const s = await load();
    expect(s.labour).toMatchObject({ available: true, pendingMilli: 1500 });
    expect(s.labour.days).toEqual([
      { userId: "sam", name: "Sam Sparky", date: "2026-11-10", milli: 4500, costRateCents: 4800, chargeOutRateCents: 9500 },
      { userId: "dy", name: "Dylan Sinclair", date: "2026-11-11", milli: 3000, costRateCents: null, chargeOutRateCents: null },
      { userId: "sam", name: "Sam Sparky", date: "2026-11-11", milli: 7600, costRateCents: 4800, chargeOutRateCents: 9500 },
    ]);
  });

  it("supplier lines are offered one by one only when they add up to what was booked here", async () => {
    const s = await load();
    expect(s.supplier.lines.map((l: { id: string; costCents: number }) => [l.id, l.costCents])).toEqual([["l1", 18500], ["l2", 7440], ["l4", -4650]]);
    // the split invoice, and the receipt with no lines, are each one amount
    expect(s.supplier.whole.map((w: { id: string; costCents: number; supplier: string }) => [w.id, w.costCents, w.supplier])).toEqual([["i2", 12000, "MMEM"], ["i4", 2200, "Unknown supplier"]]);
    expect(s.supplier.lines[2]).toMatchObject({ credit: true, supplier: "Rexel", number: "CN-4" });
  });

  it("typed dockets from the job's materials ledger", async () => {
    expect((await load()).ledger).toEqual({ available: true, reason: null, lines: [{ id: "ml_1", date: "2026-11-11", supplier: "Bunnings", description: null, number: "D-88", costCents: 3460 }] });
  });

  it("a source that is switched off is simply not there", async () => {
    const supplierBreakdown = vi.fn();
    const ledger = vi.fn();
    const s = await load(baseDeps({ supplierBreakdown, ledger }), { supplierInvoices: false, ledger: false });
    expect(s.supplier).toMatchObject({ available: false, reason: "off", lines: [], whole: [] });
    expect(s.ledger).toMatchObject({ available: false, reason: "off", lines: [] });
    expect(supplierBreakdown).not.toHaveBeenCalled();
    expect(ledger).not.toHaveBeenCalled();
  });

  it("one source failing never takes the others down with it", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await load(baseDeps({
      timeEntries: async () => { throw new Error("blob down"); },
      supplierBreakdown: async () => { throw new Error("db down"); },
    }));
    expect(s.labour).toMatchObject({ available: false, reason: "unreadable", days: [] });
    expect(s.supplier).toMatchObject({ available: false, reason: "unreadable" });
    expect(s.ledger.available).toBe(true);
    // and the failure is logged without the error's own text
    expect(JSON.stringify(spy.mock.calls)).not.toContain("blob down");
    spy.mockRestore();
  });

  it("turns logged hours into whole thousandths, and prices them without drift", () => {
    expect(B.hoursMilli(7.6)).toBe(7600);
    expect(B.hoursMilli("2.25")).toBe(2250);
    expect(B.hoursMilli(0)).toBe(0);
    expect(B.hoursMilli(-3)).toBe(0);
    expect(B.hoursMilli("soon")).toBe(0);
    expect(B.hoursCost(14350, 4800)).toBe(68880);
    expect(B.hoursCost(1, 4800)).toBe(5); // 4.8c → 5c
    expect(B.hoursCost(1000, 0)).toBeNull();
  });
});
