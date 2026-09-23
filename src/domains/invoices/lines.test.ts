import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore, type MemoryStore, type StoreFn } from "./test-helpers/memory-store";
import * as F from "./test-helpers/fixtures";

/**
 * Line items + material categories (owner pull 2026-09-24): every printed line
 * with its quantity, unit price and total, checked against the printed
 * subtotal; each line filed under a category the office can re-file, and the
 * re-filing is remembered per supplier + product.
 */
const requireFromHere = createRequire(import.meta.url);
const { extractLineItems } = requireFromHere("../../../api/_lib/invoices/lines.js");
const cats = requireFromHere("../../../api/_lib/invoices/categories.js");
const { processInvoice } = requireFromHere("../../../api/_lib/invoices/pipeline.js");

const WHOLESALER = [
  "Wholesale Wires Pty Ltd", "TAX INVOICE", "Invoice No: WW-9", "Invoice Date: 10/09/2026", "Job Number: IV0041",
  "Code      Description                          Qty    Unit     Price     Total",
  "CBL2.5T   2.5MM TWIN & EARTH TPS 100M ROLL     3      roll     89.50     268.50",
  "CT200B    CABLE TIES 200MM BLACK PK100         5      pk       4.20      21.00",
  "LED9W     9W LED DOWNLIGHT WARM WHITE          12     ea       11.00     132.00",
  "          DIMMABLE TRI COLOUR",
  "GPO2      DOUBLE POWER POINT WHITE             8      ea       6.50      52.00",
  "MCB20     20A SINGLE POLE MCB 6KA              4      ea       9.00      36.00",
  "FRT       FREIGHT                              1      ea       15.00     15.00",
  "Sub Total                                                              524.50",
  "GST 10%                                                                52.45",
  "TOTAL INC GST                                                         576.95",
];

describe("extractLineItems", () => {
  it("reads qty/unit/price/total from a columned wholesaler invoice, folds wrapped descriptions, stops at the totals block", () => {
    const r = extractLineItems(WHOLESALER, { subtotalCents: 52450, totalCents: 57695 });
    expect(r.lines.map((l: Record<string, unknown>) => [l.quantity, l.unit, l.description, l.unitPriceCents, l.lineTotalCents, l.confidence])).toEqual([
      [3, "roll", "CBL2.5T 2.5MM TWIN & EARTH TPS 100M ROLL", 8950, 26850, "high"],
      [5, "pk", "CT200B CABLE TIES 200MM BLACK PK100", 420, 2100, "high"],
      [12, "ea", "LED9W 9W LED DOWNLIGHT WARM WHITE DIMMABLE TRI COLOUR", 1100, 13200, "high"],
      [8, "ea", "GPO2 DOUBLE POWER POINT WHITE", 650, 5200, "high"],
      [4, "ea", "MCB20 20A SINGLE POLE MCB 6KA", 900, 3600, "high"],
      [1, "ea", "FRT FREIGHT", 1500, 1500, "high"],
    ]);
    expect(r).toMatchObject({ totalCents: 52450, consistent: true, reason: null });
  });
  it("reads the fixture invoice (qty first, unit price + total) and derives a unit price when only a total is printed", () => {
    const lines = F.TAX_INVOICE_IV0041.split("\n").filter((l) => l.trim());
    const r = extractLineItems(lines, { subtotalCents: 108000, totalCents: 118800 });
    expect(r.lines.map((l: Record<string, unknown>) => [l.quantity, l.description, l.unitPriceCents, l.lineTotalCents])).toEqual([
      [10, "2.5mm TPS cable 100m", 8400, 84000],
      [2, "Switchboard enclosure", 12000, 24000],
    ]);
    expect(r.consistent).toBe(true);
    const noHeader = extractLineItems(["Volt Electrical", "Tax Invoice 10442", "20mm Corrugated Conduit 50m   2   36.30", "Dynabolt 10x75 Box 50   1   27.50", "Total (ex GST) 58.00", "GST 5.80", "Total 63.80"], { subtotalCents: 5800, totalCents: 6380 });
    expect(noHeader.lines.map((l: Record<string, unknown>) => [l.quantity, l.unitPriceCents, l.lineTotalCents])).toEqual([[2, 1815, 3630], [1, 2750, 2750]]);
    expect(noHeader).toMatchObject({ consistent: false, reason: "lines_include_gst" });
  });
  it("never invents lines: address/ABN/date rows and money-only rows are not items; no lines → says so", () => {
    const r = extractLineItems(["Sparky Supplies", "ABN 51 824 753 556", "Invoice Date: 03/09/2026 1,188.00", "Sub Total 1,080.00"], { subtotalCents: 108000 });
    expect(r.lines).toEqual([]);
    expect(r.reason).toBe("no_lines_read");
    const bad = extractLineItems(["Qty Description Total", "1 Widget 10.00", "1 Gadget 20.00", "Sub Total 100.00"], { subtotalCents: 10000, totalCents: 11000 });
    expect(bad).toMatchObject({ totalCents: 3000, consistent: false, reason: "lines_do_not_add_up" });
  });
});

describe("categorise — site language buckets, priority order, learned keys", () => {
  it("files common wholesale lines where an electrician would", () => {
    const of = (d: string) => cats.categorise(d).category;
    expect(of("2.5MM TWIN & EARTH TPS 100M ROLL")).toBe("cable");
    expect(of("CABLE TIES 200MM BLACK PK100")).toBe("fixings"); // a cable tie is a fixing, not cable
    expect(of("9W LED DOWNLIGHT WARM WHITE")).toBe("lighting");
    expect(of("DOUBLE POWER POINT WHITE")).toBe("accessories");
    expect(of("20A SINGLE POLE MCB 6KA")).toBe("switchgear");
    expect(of("Switchboard enclosure 24 pole")).toBe("boards");
    expect(of("20mm Corrugated Conduit 50m")).toBe("conduit");
    expect(of("Conduit saddle 20mm")).toBe("conduit");
    expect(of("Dynabolt 10x75 Box 50")).toBe("fixings");
    expect(of("Cat6 UTP solid 305m box blue")).toBe("data");
    expect(of("Insulation tape black 18mm")).toBe("consumables");
    expect(of("FREIGHT")).toBe("freight");
    expect(of("Test & tag labels roll")).toBe("testing");
    expect(of("Cordless impact driver 18V")).toBe("tools");
    expect(of("Mystery item 42")).toBe("other");
    expect(cats.categorise("").confidence).toBe("low");
  });
  it("description keys collapse case and punctuation so the same product matches next time", () => {
    expect(cats.descriptionKey("  9W LED Downlight, Warm-White ")).toBe("9w led downlight warm white");
    expect(cats.descriptionKey("")).toBeNull();
    expect(cats.isCategory("lighting")).toBe(true);
    expect(cats.isCategory("stuff")).toBe(false);
  });
});

describe("pipeline — lines are stored, filed, and learned choices win", () => {
  let store: MemoryStore;
  const T = "tenant";
  let n = 0;
  async function seed(text: string) {
    const r = (await (store.createInvoiceWithDocument as StoreFn)(null, T,
      { source: "upload", createdBy: { id: "u", name: "Office" } },
      { source: "upload", filename: "d.pdf", contentType: "application/pdf", byteSize: 100, sha256: String(++n).padStart(64, "0"), blobPathname: "p", blobUrl: `blob://${encodeURIComponent(text)}` })) as { invoice: { id: string } };
    await (store.claimOne as StoreFn)(null, T, r.invoice.id);
    return r.invoice.id;
  }
  const deps = (over: Record<string, unknown> = {}) => ({
    store,
    fetchPdf: async (url: string) => Buffer.from(decodeURIComponent(url.slice("blob://".length))),
    extractText: async (bytes: Buffer) => ({ text: bytes.toString(), pageCount: 1, hasTextLayer: true }),
    readJobs: async () => F.JOBS,
    aiExtract: null,
    ...over,
  });
  beforeEach(() => { store = createMemoryStore(); });

  it("a wholesaler invoice lands with six filed lines that add up; a statement gets none", async () => {
    const id = await seed(WHOLESALER.join("\n"));
    await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "upload", deps: deps() });
    const inv = store.invoices[0]!;
    expect(inv).toMatchObject({ status: "matched", linesTotalCents: 52450, linesConsistent: true });
    const lines = store.lines.filter((l) => l.invoiceId === id);
    expect(lines.map((l) => [l.lineNo, l.category, l.categorySource])).toEqual([
      [1, "cable", "rule"], [2, "fixings", "rule"], [3, "lighting", "rule"], [4, "accessories", "rule"], [5, "switchgear", "rule"], [6, "freight", "rule"],
    ]);
    expect(store.events.find((e) => e.event === "lines_read")?.detail).toMatchObject({ count: 6, consistent: true, source: "rule" });
    const st = await seed(F.STATEMENT);
    await processInvoice({ sql: null, tenantId: T, invoiceId: st, trigger: "upload", deps: deps() });
    expect(store.lines.filter((l) => l.invoiceId === st)).toEqual([]);
    expect(store.invoices.find((r) => r.id === st)!.linesTotalCents).toBeNull();
  });
  it("a remembered category for this supplier's product beats the keyword rule; a re-read keeps it", async () => {
    await (store.rememberCategory as StoreFn)(null, T, { supplierKey: "wholesale wires", descriptionKey: "frt freight", category: "other", actor: { id: "u", name: "Office" } });
    const id = await seed(WHOLESALER.join("\n"));
    await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "upload", deps: deps() });
    const freight = store.lines.find((l) => l.invoiceId === id && l.lineNo === 6)!;
    expect(freight).toMatchObject({ category: "other", categorySource: "learned" });
    await (store.claimOne as StoreFn)(null, T, id, { resetAttempts: true });
    await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "retry", deps: deps() });
    expect(store.lines.filter((l) => l.invoiceId === id)).toHaveLength(6);
    expect(store.lines.find((l) => l.invoiceId === id && l.lineNo === 6)).toMatchObject({ category: "other", categorySource: "learned" });
  });
  it("the AI rung's lines are used only when the rules' lines do not add up and the model's do; its categories fill 'other'", async () => {
    const text = ["Odd Layout Supplies Pty Ltd", "TAX INVOICE", "Invoice No: OL-1", "Invoice Date: 10/09/2026", "Job Number: IV0041", "Widget thing 10.00", "Sub Total 30.00", "GST 3.00", "Total 33.00"].join("\n");
    const id = await seed(text);
    const aiExtract = async () => ({
      documentType: "tax_invoice", supplierName: null, supplierInvoiceNumber: null, invoiceDate: null, subtotalCents: null, gstCents: null, totalCents: null, confidence: {},
      lines: [
        { description: "Widget thing", quantity: 1, unit: "ea", unitPriceCents: 1000, lineTotalCents: 1000, category: "consumables" },
        { description: "Gizmo", quantity: 2, unit: "ea", unitPriceCents: 1000, lineTotalCents: 2000, category: "tools" },
      ],
    });
    await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "upload", deps: deps({ aiExtract }) });
    const lines = store.lines.filter((l) => l.invoiceId === id);
    expect(lines.map((l) => [l.description, l.category, l.categorySource])).toEqual([["Widget thing", "consumables", "ai"], ["Gizmo", "tools", "ai"]]);
    expect(store.invoices.find((r) => r.id === id)).toMatchObject({ linesTotalCents: 3000, linesConsistent: true, extractionMethod: "pdf_text+ai" });
  });
});
