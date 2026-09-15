import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore, type MemoryStore, type StoreFn } from "./test-helpers/memory-store";
import * as F from "./test-helpers/fixtures";

const requireFromHere = createRequire(import.meta.url);
const { processInvoice, mergeAi } = requireFromHere("../../../api/_lib/invoices/pipeline.js");

/**
 * The processing pipeline against the in-memory store: durable receipt →
 * text → extraction → duplicate rule → EXACT IV match → status. Failure
 * never loses the document; retries back off; the third failure parks it.
 */
let store: MemoryStore;
const T = "tenant";

async function seed(text: string, opts: { sha?: string; source?: string; emailId?: string } = {}) {
  const r = (await (store.createInvoiceWithDocument as StoreFn)(null, T,
    { source: opts.source ?? "upload", sourceEmailId: opts.emailId ?? null, createdBy: { id: "u", name: "Office" } },
    { source: opts.source ?? "upload", filename: "inv.pdf", contentType: "application/pdf", byteSize: 100, sha256: opts.sha ?? "a".repeat(64), blobPathname: "p", blobUrl: `blob://${encodeURIComponent(text)}` })) as { invoice: { id: string } };
  await (store.claimOne as StoreFn)(null, T, r.invoice.id);
  return r.invoice.id;
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    store,
    fetchPdf: async (url: string) => Buffer.from(decodeURIComponent(url.slice("blob://".length))),
    extractText: async (bytes: Buffer) => {
      const text = bytes.toString();
      return { text, pageCount: 1, hasTextLayer: text !== "SCANNED" };
    },
    readJobs: async () => F.JOBS,
    aiExtract: null,
    ...overrides,
  };
}

beforeEach(() => {
  store = createMemoryStore();
});

describe("processInvoice", () => {
  it("a clean tax invoice with a known IV reference lands as matched — awaiting confirmation, never confirmed", async () => {
    const id = await seed(F.TAX_INVOICE_IV0041);
    const r = await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "upload", deps: deps() });
    expect(r).toEqual({ ok: true, status: "matched" });
    const inv = store.invoices[0];
    expect(inv).toMatchObject({ status: "matched", matchStatus: "exact", matchedJobId: "birdwood", ivReference: "IV0041", ivReferenceRaw: "IV 0041", supplierInvoiceNumber: "SS-88123", subtotalCents: 108000, gstCents: 10800, totalCents: 118800, totalsConsistent: true, extractionMethod: "pdf_text", supplierKey: "sparky supplies" });
    expect(store.allocations).toEqual([]); // nothing costed without a human
    expect(store.events.map((e) => e.event)).toEqual(["uploaded", "extracted", "matched"]);
    expect(store.attempts[0]).toMatchObject({ outcome: "ok", trigger: "upload", attemptNo: 1 });
  });

  it("an unknown IV reference goes to review with the reason recorded", async () => {
    const id = await seed(F.INVOICE_UNKNOWN_IV);
    await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "upload", deps: deps() });
    expect(store.invoices[0]).toMatchObject({ status: "needs_review", matchStatus: "not_found", matchedJobId: null, reviewReasons: ["iv_not_found"] });
  });

  it("a scanned PDF (no text layer) goes to manual entry without losing the document", async () => {
    const id = await seed("SCANNED");
    const r = await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "upload", deps: deps() });
    expect(r.status).toBe("needs_review");
    expect(store.invoices[0]).toMatchObject({ status: "needs_review", reviewReasons: ["no_text_layer"], extractionMethod: "none" });
    expect(store.documents[0]).toMatchObject({ hasTextLayer: false, pageCount: 1 });
  });

  it("the same attachment arriving in a second email is a duplicate by checksum", async () => {
    const first = await seed(F.TAX_INVOICE_IV0041, { sha: "b".repeat(64), source: "email", emailId: "e1" });
    await processInvoice({ sql: null, tenantId: T, invoiceId: first, trigger: "webhook", deps: deps() });
    const second = await seed(F.TAX_INVOICE_IV0041, { sha: "b".repeat(64), source: "email", emailId: "e2" });
    const r = await processInvoice({ sql: null, tenantId: T, invoiceId: second, trigger: "webhook", deps: deps() });
    expect(r.status).toBe("duplicate");
    expect(store.invoices[1]).toMatchObject({ status: "duplicate", duplicateOfId: first, duplicateReason: "checksum", supplierInvoiceNumber: "SS-88123" });
  });

  it("the same supplier invoice uploaded after being emailed (different bytes) is a duplicate by supplier + number", async () => {
    const first = await seed(F.TAX_INVOICE_IV0041, { sha: "c".repeat(64), source: "email", emailId: "e1" });
    await processInvoice({ sql: null, tenantId: T, invoiceId: first, trigger: "webhook", deps: deps() });
    const second = await seed(F.TAX_INVOICE_IV0041 + "\n", { sha: "d".repeat(64) }); // re-printed, different bytes
    await processInvoice({ sql: null, tenantId: T, invoiceId: second, trigger: "upload", deps: deps() });
    expect(store.invoices[1]).toMatchObject({ status: "duplicate", duplicateOfId: first, duplicateReason: "supplier_invoice_number" });
  });

  it("the same invoice number from two different suppliers is NOT a duplicate", async () => {
    const a = await seed(F.TAX_INVOICE_IV0041, { sha: "e".repeat(64) });
    await processInvoice({ sql: null, tenantId: T, invoiceId: a, trigger: "upload", deps: deps() });
    const other = F.TAX_INVOICE_IV0041.replace("Sparky Supplies Pty Ltd", "Other Wholesale Pty Ltd");
    const b = await seed(other, { sha: "f".repeat(64) });
    await processInvoice({ sql: null, tenantId: T, invoiceId: b, trigger: "upload", deps: deps() });
    expect(store.invoices[1].status).toBe("matched");
  });

  it("a statement that lists an invoice number is NOT a duplicate of that invoice", async () => {
    const a = await seed(F.TAX_INVOICE_IV0041, { sha: "7".repeat(64) });
    await processInvoice({ sql: null, tenantId: T, invoiceId: a, trigger: "upload", deps: deps() });
    const s = await seed(F.STATEMENT, { sha: "8".repeat(64) });
    await processInvoice({ sql: null, tenantId: T, invoiceId: s, trigger: "upload", deps: deps() });
    expect(store.invoices[1]).toMatchObject({ status: "needs_review", documentType: "statement", duplicateOfId: null });
    expect(store.invoices[1].reviewReasons).toContain("not_allocatable");
  });

  it("a missing supplier invoice number never matches anything as a duplicate", async () => {
    const a = await seed("Wholesale Wires Pty Ltd\nTAX INVOICE\nJob Number: IV0041\nSub Total 10.00\nGST 1.00\nTotal 11.00", { sha: "1".repeat(64) });
    await processInvoice({ sql: null, tenantId: T, invoiceId: a, trigger: "upload", deps: deps() });
    const b = await seed("Wholesale Wires Pty Ltd\nTAX INVOICE\nJob Number: IV0041\nSub Total 20.00\nGST 2.00\nTotal 22.00", { sha: "2".repeat(64) });
    await processInvoice({ sql: null, tenantId: T, invoiceId: b, trigger: "upload", deps: deps() });
    expect(store.invoices.map((i) => i.status)).toEqual(["matched", "matched"]);
  });

  it("a transient failure keeps the row retryable with backoff; the third failure parks it as failed", async () => {
    const id = await seed(F.TAX_INVOICE_IV0041);
    const failing = deps({ fetchPdf: async () => { const e = new Error("blob down") as Error & { code: string }; e.code = "document_unavailable"; throw e; } });
    let r = await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "upload", deps: failing });
    expect(r).toMatchObject({ ok: false, status: "received", code: "document_unavailable" });
    expect(store.invoices[0].nextAttemptAt).toBeTruthy();
    expect(store.documents).toHaveLength(1);
    await (store.claimOne as StoreFn)(null, T, id);
    r = await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "sweep", deps: failing });
    expect(r.status).toBe("received");
    await (store.claimOne as StoreFn)(null, T, id);
    r = await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "sweep", deps: failing });
    expect(r.status).toBe("failed");
    expect(store.invoices[0]).toMatchObject({ status: "failed", failureCode: "document_unavailable", attemptCount: 3 });
    expect(store.attempts).toHaveLength(3);
  });

  it("the optional AI rung only fills gaps and never touches the IV match", async () => {
    const id = await seed(F.INVOICE_MISSING_SUBTOTAL);
    const ai = async () => ({ documentType: "tax_invoice", supplierName: null, supplierInvoiceNumber: "AI-SAYS-OTHER", invoiceDate: null, subtotalCents: 10000, gstCents: 1000, totalCents: 11000, confidence: { subtotalCents: "high" } });
    await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "upload", deps: deps({ aiExtract: ai }) });
    const inv = store.invoices[0];
    expect(inv.supplierInvoiceNumber).toBe("WW-4"); // parser value kept
    expect(inv.subtotalCents).toBe(10000);
    expect(inv.totalsConsistent).toBe(true);
    expect(inv.extractionMethod).toBe("pdf_text+ai");
    expect((inv.fields as Record<string, { provenance: string }>).subtotalCents.provenance).toBe("ai");
    expect(inv).toMatchObject({ status: "matched", matchedJobId: "birdwood" });
  });

  it("an AI failure never fails the document", async () => {
    const id = await seed(F.INVOICE_MISSING_SUBTOTAL);
    await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "upload", deps: deps({ aiExtract: async () => { throw new Error("quota"); } }) });
    expect(store.invoices[0]).toMatchObject({ status: "needs_review", extractionMethod: "pdf_text" });
  });
});

describe("mergeAi", () => {
  it("does not overwrite parsed values and reconciles the merged totals", () => {
    const base = { documentType: "unknown", supplierName: "X", supplierInvoiceNumber: null, invoiceDate: null, subtotalCents: 500, gstCents: null, totalCents: null, totalsConsistent: null, fields: {}, ivSelection: { outcome: "none" } };
    const out = mergeAi(base, { documentType: "invoice", supplierName: "Y", supplierInvoiceNumber: "N1", invoiceDate: "2026-01-02", subtotalCents: 999, gstCents: 50, totalCents: null, confidence: {} });
    expect(out.supplierName).toBe("X");
    expect(out.subtotalCents).toBe(500);
    expect(out.gstCents).toBe(50);
    expect(out.totalCents).toBe(550);
    expect(out.totalsConsistent).toBe(true);
    expect(out.documentType).toBe("invoice");
    expect(out.fields.supplierInvoiceNumber.provenance).toBe("ai");
  });
});
