import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore, type MemoryStore, type StoreFn } from "./test-helpers/memory-store";
import * as F from "./test-helpers/fixtures";

/**
 * Statement check (owner direction 2026-09-23): a supplier statement's invoice
 * lines are compared with what was captured, so the invoice that never arrived
 * is caught before the supplier chases it.
 */
const requireFromHere = createRequire(import.meta.url);
const st = requireFromHere("../../../api/_lib/invoices/statement.js");
const { processInvoice } = requireFromHere("../../../api/_lib/invoices/pipeline.js");

const STATEMENT = `Sparky Supplies Pty Ltd
STATEMENT OF ACCOUNT
Account No: BUHL01
Statement Date: 30/09/2026
Statement No: 778812
Date        Reference        Job        Amount      Balance
03/09/2026  Invoice SS-88123  IV0041    1,188.00    1,188.00
17/09/2026  Invoice SS-88200  IV0041    350.00      1,538.00
20/09/2026  Credit CN-45                -50.00      1,488.00
10/09/2026  Payment received - thank you  -1,000.00  488.00
Current 488.00   30 Days 0.00   60 Days 0.00   90+ Days 0.00
Balance Due 488.00
Terms 30 days from invoice date`;

describe("extractStatementLines", () => {
  it("reads invoice and credit lines with reference, date and amount; skips headings, payments, ageing and balances", () => {
    const lines = st.extractStatementLines(STATEMENT);
    expect(lines.map((l: { ref: string; kind: string; amountCents: number; date: string }) => [l.ref, l.kind, l.amountCents, l.date])).toEqual([
      ["SS-88123", "invoice", 118800, "03/09/2026"],
      ["SS-88200", "invoice", 35000, "17/09/2026"],
      ["CN-45", "credit", -5000, "20/09/2026"],
    ]);
  });
  it("never takes an IV job code, a year or a date fragment as the reference", () => {
    expect(st.extractStatementLines("IV0041 Birdwood 2026 12.00")).toEqual([]);
    expect(st.extractStatementLines("03/09/2026 1,188.00")).toEqual([]);
    expect(st.extractStatementLines("Inv 88123 1,188.00")[0]?.ref).toBe("88123");
  });
  it("compares loosely on punctuation but never fuzzily", () => {
    expect(st.looseNumberKey(" ss-88 123 ")).toBe("SS88123");
    const r = st.reconcileStatement(st.extractStatementLines(STATEMENT), [
      { id: "a", supplierInvoiceNumber: "SS 88123", status: "confirmed", documentType: "tax_invoice", totalCents: 118800 },
      { id: "b", supplierInvoiceNumber: "SS-88201", status: "matched", documentType: "tax_invoice", totalCents: 35000 }, // one digit off: NOT a match
    ]);
    expect(r.listed).toBe(3);
    expect(r.matched).toEqual([{ ref: "SS-88123", invoiceId: "a", status: "confirmed", documentType: "tax_invoice", amountCents: 118800, capturedTotalCents: 118800 }]);
    expect(r.missing.map((m: { ref: string }) => m.ref)).toEqual(["SS-88200", "CN-45"]);
  });
});

describe("pipeline — a statement is checked against this supplier's captured invoices", () => {
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
  const deps = () => ({
    store,
    fetchPdf: async (url: string) => Buffer.from(decodeURIComponent(url.slice("blob://".length))),
    extractText: async (bytes: Buffer) => ({ text: bytes.toString(), pageCount: 1, hasTextLayer: true }),
    readJobs: async () => F.JOBS,
    aiExtract: null,
  });
  beforeEach(() => { store = createMemoryStore(); });

  it("names the invoices on the statement that were never captured, and links the ones that were", async () => {
    const invId = await seed(F.TAX_INVOICE_IV0041); // SS-88123 from Sparky Supplies
    await processInvoice({ sql: null, tenantId: T, invoiceId: invId, trigger: "upload", deps: deps() });
    const stId = await seed(STATEMENT);
    const r = await processInvoice({ sql: null, tenantId: T, invoiceId: stId, trigger: "upload", deps: deps() });
    expect(r).toEqual({ ok: true, status: "needs_review" });
    const row = store.invoices.find((x) => x.id === stId)!;
    expect(row.documentType).toBe("statement");
    expect(row.reviewReasons).toContain("not_allocatable");
    expect(row.reviewReasons).toContain("statement_missing_invoices");
    expect(row.status).toBe("needs_review");
    const check = (row.matchReason as { statement: { listed: number; matched: Array<{ invoiceId: string }>; missing: Array<{ ref: string }> } }).statement;
    expect(check.listed).toBe(3);
    expect(check.matched.map((m) => m.invoiceId)).toEqual([invId]);
    expect(check.missing.map((m) => m.ref)).toEqual(["SS-88200", "CN-45"]);
    expect(store.allocations).toEqual([]); // a statement never books anything
  });
  it("a statement whose invoices are all captured carries no extra reason", async () => {
    const a = await seed(F.TAX_INVOICE_IV0041);
    await processInvoice({ sql: null, tenantId: T, invoiceId: a, trigger: "upload", deps: deps() });
    const stId = await seed(F.STATEMENT.replace("Invoice SS-88200  17/09/2026  350.00\n", ""));
    await processInvoice({ sql: null, tenantId: T, invoiceId: stId, trigger: "upload", deps: deps() });
    const row = store.invoices.find((x) => x.id === stId)!;
    expect(row.reviewReasons).not.toContain("statement_missing_invoices");
    expect((row.matchReason as { statement: { missing: unknown[] } }).statement.missing).toEqual([]);
  });
});
