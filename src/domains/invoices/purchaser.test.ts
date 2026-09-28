import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore, type MemoryStore, type StoreFn } from "./test-helpers/memory-store";
import * as F from "./test-helpers/fixtures";

/**
 * Who was at the counter (owner, 2026-09-28): wholesalers sometimes print the
 * person who ordered or collected. BuhlOS reads the name as printed, matches it
 * to ONE employee or none, shows it, and — when no IV number is printed — uses
 * the job that worker logged hours on that day as medium placement evidence.
 */
const requireFromHere = createRequire(import.meta.url);
const pu = requireFromHere("../../../api/_lib/invoices/purchaser.js");
const { extractInvoiceFromText } = requireFromHere("../../../api/_lib/invoices/extract.js");
const { processInvoice } = requireFromHere("../../../api/_lib/invoices/pipeline.js");
const { evaluateAutoConfirm } = requireFromHere("../../../api/_lib/invoices/auto-confirm.js");

const USERS = [
  { id: "u_alfie", name: "Alfredo Hughes", preferredName: "Alfie", role: "apprentice" },
  { id: "u_simon", name: "Simon Exkhof", preferredName: "Simon", role: "electrician" },
  { id: "u_dylan", name: "Dylan Sinclair", role: "electrician" },
  { id: "u_louis", name: "Louis Kane", preferredName: "Louie", role: "electrician" },
  { id: "u_steve1", name: "Stephen Mayne", role: "electrician" },
  { id: "u_steve2", name: "Stephen Other", role: "apprentice" },
  { id: "u_client", name: "Dylan Client", role: "client" },
];

describe("extractPurchaserName", () => {
  it("reads the buyer under every common label, tidies capitals, and never reads the wholesaler's own staff", () => {
    const of = (l: string[]) => pu.extractPurchaserName(l);
    expect(of(["Ordered by: Sam"])).toBe("Sam");
    expect(of(["Picked up by: DYLAN S"])).toBe("Dylan S");
    expect(of(["Contact: Simon Exkhof      Ph 0400 000 000"])).toBe("Simon Exkhof");
    expect(of(["ORDERED BY    CRAIG"])).toBe("Craig");
    expect(of(["Served by: Kevin", "Customer Contact: Louie"])).toBe("Louie");
    expect(of(["Sales rep: Janet"])).toBeNull();
    expect(of(["Received by: ____________"])).toBeNull();
    expect(of(["Attn: Buhl Electrical"])).toBeNull();
    expect(of(["Contact: 0412 345 678"])).toBeNull();
    expect(of(["Account: BUHL01"])).toBeNull();
  });
  it("comes out of the invoice extractor", () => {
    expect(extractInvoiceFromText(F.TAX_INVOICE_IV0041 + "\nOrdered by: Dylan S").purchaserName).toBe("Dylan S");
    expect(extractInvoiceFromText(F.TAX_INVOICE_IV0041).purchaserName).toBeNull();
  });
});

describe("matchWorker — one employee or none", () => {
  it("full name, first + initial, a unique first name, a preferred name", () => {
    expect(pu.matchWorker("Simon Exkhof", USERS)).toMatchObject({ userId: "u_simon", via: "full_name" });
    expect(pu.matchWorker("Dylan S", USERS)).toMatchObject({ userId: "u_dylan", via: "first_initial" });
    expect(pu.matchWorker("Dylan", USERS)).toMatchObject({ userId: "u_dylan", via: "first_name" }); // the client is never a match
    expect(pu.matchWorker("Louie", USERS)).toMatchObject({ userId: "u_louis", via: "preferred_name" });
  });
  it("two Stephens is no match; an unknown name is no match", () => {
    expect(pu.matchWorker("Stephen", USERS)).toEqual({ ambiguous: true, names: ["Stephen Mayne", "Stephen Other"] });
    expect(pu.matchWorker("Sam", USERS)).toBeNull();
    expect(pu.matchWorker("", USERS)).toBeNull();
  });
  it("jobsFromEntry: jobs with hours that day; a rejected day counts for nothing", () => {
    expect(pu.jobsFromEntry({ status: "submitted", allocations: [{ jobId: "birdwood", hours: 6 }, { jobId: "kent-st", hours: 0 }, { jobId: "birdwood", hours: 2 }] })).toEqual(["birdwood"]);
    expect(pu.jobsFromEntry({ status: "rejected", allocations: [{ jobId: "birdwood", hours: 8 }] })).toEqual([]);
    expect(pu.jobsFromEntry(null)).toEqual([]);
  });
});

describe("pipeline — the buyer's timesheet places an invoice with no IV number", () => {
  let store: MemoryStore;
  const T = "tenant";
  let n = 0;
  const NO_IV = ["Boutique Lighting Co", "TAX INVOICE", "Invoice No: BL-9", "Invoice Date: 15/09/2026", "Picked up by: DYLAN S", "Qty   Description                 Total", "2     Pendant light black         380.00", "Sub Total 380.00", "GST 38.00", "Total 418.00"].join("\n");
  async function seed(text: string) {
    const r = (await (store.createInvoiceWithDocument as StoreFn)(null, T, { source: "upload", createdBy: { id: "u", name: "Office" } },
      { source: "upload", filename: "d.pdf", contentType: "application/pdf", byteSize: 10, sha256: String(++n).padStart(64, "0"), blobPathname: "p", blobUrl: `blob://${encodeURIComponent(text)}` })) as { invoice: { id: string } };
    await (store.claimOne as StoreFn)(null, T, r.invoice.id);
    return r.invoice.id;
  }
  const deps = (jobsThatDay: string[], over: Record<string, unknown> = {}) => ({
    store,
    fetchPdf: async (url: string) => Buffer.from(decodeURIComponent(url.slice("blob://".length))),
    extractText: async (b: Buffer) => ({ text: b.toString(), pageCount: 1, hasTextLayer: true }),
    readJobs: async () => F.JOBS,
    readUsers: async () => USERS,
    workerJobsOn: async (userId: string, date: string) => (userId === "u_dylan" && date === "2026-09-15" ? jobsThatDay : []),
    aiExtract: null,
    ...over,
  });
  beforeEach(() => { store = createMemoryStore(); });

  it("Dylan logged hours only on Birdwood that day → placed there (medium), buyer recorded, and it never books itself", async () => {
    const id = await seed(NO_IV);
    const r = await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "upload", deps: deps(["birdwood"]) });
    expect(r).toEqual({ ok: true, status: "matched" });
    const row = store.invoices[0]!;
    expect(row).toMatchObject({ matchStatus: "inferred", matchedJobId: "birdwood", purchaserName: "Dylan S", purchaserUserId: "u_dylan", purchaserWorkerName: "Dylan Sinclair" });
    const reason = row.matchReason as { strength: string; evidence: Array<{ kind: string; detail: string }> };
    expect(reason.strength).toBe("medium");
    expect(reason.evidence[0]).toMatchObject({ kind: "timesheet" });
    expect(reason.evidence[0]!.detail).toContain("Dylan Sinclair (named on the invoice) logged hours on this job on 2026-09-15");
    const v = evaluateAutoConfirm({ ...row, fields: { subtotalCents: { value: 38000, provenance: "pdf_text" }, gstCents: { value: 3800, provenance: "pdf_text" }, totalCents: { value: 41800, provenance: "pdf_text" } } },
      { capCents: 500_000, lookbackDays: 90, supplierHumanConfirmed: true, supplierAlwaysReview: false, supplierConfirmedOnJob: false, jobStatus: "active", now: new Date("2026-09-20T00:00:00Z"), allowInferred: true });
    expect(v.eligible).toBe(false); // timesheet evidence is medium: never books itself
  });
  it("two jobs that day → a choice for a person, both offered", async () => {
    const id = await seed(NO_IV);
    await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "upload", deps: deps(["birdwood", "kent-st"]) });
    const row = store.invoices[0]!;
    expect(row).toMatchObject({ status: "needs_review", matchStatus: "none", matchedJobId: null, purchaserWorkerName: "Dylan Sinclair" });
    expect((row.matchReason as { suggestions: Array<{ id: string }> }).suggestions.map((s) => s.id).sort()).toEqual(["birdwood", "kent-st"]);
  });
  it("an IV number always wins: the timesheet is not even read, the buyer is still recorded", async () => {
    let asked = 0;
    const id = await seed(F.TAX_INVOICE_IV0041 + "\nOrdered by: Dylan S");
    await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "upload", deps: deps(["kent-st"], { workerJobsOn: async () => { asked++; return ["kent-st"]; } }) });
    expect(store.invoices[0]).toMatchObject({ matchStatus: "exact", matchedJobId: "birdwood", purchaserWorkerName: "Dylan Sinclair" });
    expect(asked).toBe(0);
  });
  it("an ambiguous or unknown name is kept as printed, matched to nobody, and places nothing", async () => {
    const id = await seed(NO_IV.replace("DYLAN S", "Stephen"));
    await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "upload", deps: deps(["birdwood"]) });
    expect(store.invoices[0]).toMatchObject({ purchaserName: "Stephen", purchaserUserId: null, purchaserWorkerName: null, matchStatus: "none", status: "needs_review" });
  });
  it("a user lookup failure never fails the document", async () => {
    const id = await seed(NO_IV);
    const r = await processInvoice({ sql: null, tenantId: T, invoiceId: id, trigger: "upload", deps: deps([], { readUsers: async () => { throw new Error("blob down"); } }) });
    expect(r.ok).toBe(true);
    expect(store.invoices[0]).toMatchObject({ purchaserName: "Dylan S", purchaserUserId: null });
  });
});
