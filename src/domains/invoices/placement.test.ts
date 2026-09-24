import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStore, type MemoryStore, type StoreFn } from "./test-helpers/memory-store";
import * as F from "./test-helpers/fixtures";

/**
 * Evidence placement (owner direction 2026-09-24): a document with NO IV
 * number is placed from what it does print — delivery address, job name, job
 * ref — with the evidence named. An IV number always wins; two candidates are
 * an ambiguity offered to the reviewer; only a strong (address) placement may
 * book itself, and only when the owner knob allows it.
 */
const requireFromHere = createRequire(import.meta.url);
const pl = requireFromHere("../../../api/_lib/invoices/placement.js");
const { extractInvoiceFromText } = requireFromHere("../../../api/_lib/invoices/extract.js");
const { processInvoice, decideMatch } = requireFromHere("../../../api/_lib/invoices/pipeline.js");
const { evaluateAutoConfirm } = requireFromHere("../../../api/_lib/invoices/auto-confirm.js");

const JOBS = [
  { id: "sansara", name: "Sansara Gym Double Bay", siteAddress: "2 Bay St Double Bay", status: "active" },
  { id: "birdwood", name: "Birdwood", siteAddress: "17 Birdwood Ave", code: "IV0041", status: "active" },
  { id: "rod", name: "DCA Unit 6 10 Rodborough Road Frenchs Forest", siteAddress: "6/10 Rodborough Road, Frenchs Forest NSW 2086", code: "IV3377", status: "active" },
  { id: "gard", name: "DCA 2/494 Gardeners Road Alexandria", siteAddress: "494-504 Gardeners Road, Alexandria NSW 2015", code: "IV3370", status: "active" },
  { id: "office", name: "Buhl office", status: "active" },
  { id: "old", name: "Old Norfolk", siteAddress: "21 Norfolk St Paddington", status: "complete" },
  { id: "gone", name: "Deleted job", siteAddress: "17 Birdwood Ave", deleted: true },
];
const BOUTIQUE = ["Boutique Lighting Co", "ABN 11 222 333 444", "TAX INVOICE 4471", "Date: 12/09/2026", "Bill To: Buhl Electrical Pty Ltd", "Deliver To: Unit 6, 10 Rodborough Rd", "Frenchs Forest NSW 2086", "Qty  Description                 Total", "2    Pendant light black         380.00", "Sub Total 380.00", "GST 38.00", "Total 418.00"];

describe("addressKey / sameAddress", () => {
  it("normalises abbreviations, units and ranges so the same street matches", () => {
    expect(pl.addressKey("Unit 6, 10 Rodborough Rd, Frenchs Forest NSW 2086").key).toBe("10 rodborough road");
    expect(pl.addressKey("6/10 Rodborough Road, Frenchs Forest").key).toBe("10 rodborough road");
    expect(pl.addressKey("17 Birdwood Ave").key).toBe("17 birdwood avenue");
    expect(pl.sameAddress(pl.addressKey("2/494 Gardeners Road"), pl.addressKey("494-504 Gardeners Road, Alexandria"))).toBe(true);
    expect(pl.sameAddress(pl.addressKey("17 Birdwood Ave"), pl.addressKey("71 Birdwood Ave"))).toBe(false);
    expect(pl.sameAddress(pl.addressKey("17 Birdwood Ave"), pl.addressKey("17 Birdwood St"))).toBe(false);
    expect(pl.addressKey("Buhl office")).toBeNull();
  });
});

describe("extractDeliveryAddress", () => {
  it("reads the delivery block after its label, with a suburb line, and stops at anything that is not an address", () => {
    expect(pl.extractDeliveryAddress(BOUTIQUE)).toBe("Unit 6, 10 Rodborough Rd, Frenchs Forest NSW 2086");
    expect(pl.extractDeliveryAddress(["Ship to: 17 Birdwood Avenue", "Also for Sansara Gym", "1 thing 10.00"])).toBe("17 Birdwood Avenue");
    expect(pl.extractDeliveryAddress(["Bill To: 5 Office St", "1 thing 10.00"])).toBeNull(); // billing is not delivery
  });
});

describe("inferPlacement", () => {
  const run = (lines: string[]) => pl.inferPlacement({ text: lines.join("\n"), deliveryAddress: pl.extractDeliveryAddress(lines), references: [] }, JOBS);
  it("a delivery address that is one job's site places it strongly; deleted jobs are never candidates", () => {
    const r = run(BOUTIQUE);
    expect(r).toMatchObject({ outcome: "placed", strength: "strong" });
    expect(r.job.id).toBe("rod");
    const bw = run(["Some Co", "Invoice 10", "Delivery address: 17 Birdwood Avenue", "1 thing 10.00"]);
    expect(bw.job.id).toBe("birdwood"); // not the deleted twin
  });
  it("a job name mentioned in the text places it with medium strength; generic names never do", () => {
    const r = run(["Fancy Fixtures", "Invoice 9", "Your ref: Birdwood level 2", "1 Brass plate 45.00"]);
    expect(r).toMatchObject({ outcome: "placed", strength: "medium" });
    expect(r.job.id).toBe("birdwood");
    expect(run(["Some Co", "Invoice 8", "Delivered to the office", "1 thing 10.00"]).outcome).toBe("none"); // "Buhl office" not mentioned; "office" too generic
  });
  it("two jobs with evidence of equal weight is an ambiguity, offered as candidates, never a guess", () => {
    const r = run(["Some Co", "Invoice 13", "Site: 17 Birdwood Ave Sydney", "Other site: 2 Bay St Double Bay", "1 thing 10.00"]);
    expect(r.outcome).toBe("ambiguous");
    expect(r.candidates.map((c: { id: string }) => c.id).sort()).toEqual(["birdwood", "sansara"]);
    expect(run(["Some Co", "Invoice 14", "Ship To: 45 Unknown Rd Somewhere", "1 thing 10.00"]).outcome).toBe("none");
  });
});

describe("decideMatch — an IV number always wins; evidence fills only its absence", () => {
  it("IV reference present → exact, evidence ignored", () => {
    const ex = extractInvoiceFromText(F.TAX_INVOICE_IV0041 + "\nDeliver To: 2 Bay St Double Bay");
    const d = decideMatch(ex, JOBS);
    expect(d.matchStatus).toBe("exact");
    expect(d.matchedJob.id).toBe("birdwood");
  });
  it("no IV, strong evidence → inferred match with the evidence recorded; ambiguity → review with candidates as suggestions", () => {
    const d = decideMatch(extractInvoiceFromText(BOUTIQUE.join("\n")), JOBS);
    expect(d).toMatchObject({ matchStatus: "inferred", reasons: [] });
    expect(d.matchedJob.id).toBe("rod");
    expect(d.matchReason).toMatchObject({ source: "evidence", strength: "strong" });
    expect(d.matchReason.evidence[0].detail).toContain("delivery address");
    const amb = decideMatch(extractInvoiceFromText(["Some Co", "TAX INVOICE 13", "Invoice No: SC-13", "Invoice Date: 12/09/2026", "Site: 17 Birdwood Ave Sydney", "Other site: 2 Bay St Double Bay", "Sub Total 10.00", "GST 1.00", "Total 11.00"].join("\n")), JOBS);
    expect(amb.matchStatus).toBe("none");
    expect(amb.reasons).toContain("no_iv_reference");
    expect(amb.matchReason.suggestions.map((s: { id: string }) => s.id).sort()).toEqual(["birdwood", "sansara"]);
  });
});

describe("auto-booking — an evidence placement books itself only when allowed and strong", () => {
  const inv = (over: Record<string, unknown>) => ({
    documentType: "tax_invoice", matchStatus: "inferred", matchedJobId: "rod", supplierKey: "boutique lighting co", supplierInvoiceNumber: "4471", invoiceDate: "2026-09-12",
    subtotalCents: 38000, gstCents: 3800, totalCents: 41800, totalsConsistent: true, reviewedAt: null, heldAt: null, duplicateOfId: null,
    fields: { subtotalCents: { value: 38000, provenance: "pdf_text", confidence: "high" }, gstCents: { value: 3800, provenance: "pdf_text", confidence: "high" }, totalCents: { value: 41800, provenance: "pdf_text", confidence: "high" } },
    matchReason: { source: "evidence", strength: "strong", matchCount: 1, evidence: [{ kind: "address", detail: "x" }] },
    ...over,
  });
  const ctx = (over: Record<string, unknown>) => ({ capCents: 500_000, lookbackDays: 90, supplierHumanConfirmed: true, supplierAlwaysReview: false, supplierConfirmedOnJob: false, jobStatus: "active", now: new Date("2026-09-24T00:00:00Z"), ...over });
  const failed = (v: { checks: Array<{ code: string; ok: boolean }> }) => v.checks.filter((c) => !c.ok).map((c) => c.code);
  it("knob off → the IV checks fail; knob on + strong → eligible; knob on + medium (name only) → still fails", () => {
    expect(failed(evaluateAutoConfirm(inv({}), ctx({ allowInferred: false })))).toEqual(["labelled_iv", "exact_match"]);
    expect(evaluateAutoConfirm(inv({}), ctx({ allowInferred: true })).eligible).toBe(true);
    expect(failed(evaluateAutoConfirm(inv({ matchReason: { source: "evidence", strength: "medium", matchCount: 1 } }), ctx({ allowInferred: true })))).toEqual(["labelled_iv", "exact_match"]);
  });
});

describe("pipeline — a boutique invoice lands matched by evidence", () => {
  let store: MemoryStore;
  const T = "tenant";
  beforeEach(() => { store = createMemoryStore(); });
  it("no IV, delivery address = a job's site → status matched, matchStatus inferred, a person still confirms unless the knob allows", async () => {
    const r = (await (store.createInvoiceWithDocument as StoreFn)(null, T, { source: "upload", createdBy: { id: "u", name: "Office" } },
      { source: "upload", filename: "b.pdf", contentType: "application/pdf", byteSize: 10, sha256: "9".repeat(64), blobPathname: "p", blobUrl: `blob://${encodeURIComponent(BOUTIQUE.join("\n"))}` })) as { invoice: { id: string } };
    await (store.claimOne as StoreFn)(null, T, r.invoice.id);
    const res = await processInvoice({ sql: null, tenantId: T, invoiceId: r.invoice.id, trigger: "upload", deps: {
      store, fetchPdf: async (url: string) => Buffer.from(decodeURIComponent(url.slice("blob://".length))), extractText: async (b: Buffer) => ({ text: b.toString(), pageCount: 1, hasTextLayer: true }), readJobs: async () => JOBS, aiExtract: null,
      autoConfirm: { enabled: true, capCents: 500_000, graceHours: 12, lookbackDays: 90, allowInferred: false },
    } });
    expect(res).toEqual({ ok: true, status: "matched" });
    const row = store.invoices[0]!;
    expect(row).toMatchObject({ status: "matched", matchStatus: "inferred", matchedJobId: "rod", ivReference: null, autoConfirmEligible: false });
    expect(store.allocations).toEqual([]);
    expect(store.events.map((e) => e.event)).toContain("matched");
  });
});
