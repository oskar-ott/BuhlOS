import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const requireFromHere = createRequire(import.meta.url);
const { evaluateAutoConfirm, autoConfirmDeadline, buildDigest, AUTO_ACTOR } = requireFromHere("../../../api/_lib/invoices/auto-confirm.js");

/**
 * The automatic-booking rule set: every check is deterministic, every failure
 * names itself, and a clean invoice is one where ALL pass.
 */
const printed = (value: unknown) => ({ value, provenance: "pdf_text", confidence: "high" });

function cleanInvoice(over: Record<string, unknown> = {}) {
  return {
    status: "matched",
    documentType: "tax_invoice",
    matchStatus: "exact",
    matchedJobId: "birdwood",
    matchReason: { source: "labelled", label: "Job Number", matchCount: 1 },
    fields: { subtotalCents: printed(108000), gstCents: printed(10800), totalCents: printed(118800) },
    totalsConsistent: true,
    supplierInvoiceNumber: "SS-88123",
    supplierName: "Sparky Supplies",
    invoiceDate: "2026-09-10",
    subtotalCents: 108000,
    duplicateOfId: null,
    reviewedAt: null,
    heldAt: null,
    ...over,
  };
}
const ctx = (over: Record<string, unknown> = {}) => ({
  capCents: 500000, lookbackDays: 90, now: new Date("2026-09-22T00:00:00Z"),
  supplierHumanConfirmed: true, supplierAlwaysReview: false, supplierConfirmedOnJob: true, jobStatus: "active", ...over,
});
const failing = (inv: Record<string, unknown>, c = ctx()) =>
  (evaluateAutoConfirm(inv, c).checks as Array<{ code: string; ok: boolean }>).filter((x) => !x.ok).map((x) => x.code);

describe("evaluateAutoConfirm", () => {
  it("a clean tax invoice passes every check", () => {
    const v = evaluateAutoConfirm(cleanInvoice(), ctx());
    expect(v.eligible).toBe(true);
    expect(v.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
    expect(v.checks.map((c: { code: string }) => c.code)).not.toContain("credit_has_invoice");
  });
  it("statements and quotes never qualify", () => {
    expect(failing(cleanInvoice({ documentType: "statement" }))).toContain("document_type");
    expect(failing(cleanInvoice({ documentType: "quote" }))).toContain("document_type");
  });
  it("an unlabelled IV token, an ambiguous or manual match, or an inactive job keeps it human", () => {
    expect(failing(cleanInvoice({ matchReason: { source: "text", matchCount: 1 } }))).toContain("labelled_iv");
    expect(failing(cleanInvoice({ matchStatus: "manual" }))).toEqual(expect.arrayContaining(["labelled_iv", "exact_match"]));
    expect(failing(cleanInvoice({ matchReason: { source: "labelled", matchCount: 2 } }))).toContain("exact_match");
    expect(failing(cleanInvoice(), ctx({ jobStatus: "complete" }))).toEqual(["job_active"]);
    expect(failing(cleanInvoice(), ctx({ jobStatus: "archived" }))).toEqual(["job_active"]);
  });
  it("derived or missing figures, or inconsistent totals, keep it human", () => {
    expect(failing(cleanInvoice({ fields: { subtotalCents: printed(1), gstCents: { value: 1, provenance: "derived" }, totalCents: printed(2) } }))).toContain("figures_printed");
    expect(failing(cleanInvoice({ fields: { subtotalCents: printed(1), totalCents: printed(2) } }))).toContain("figures_printed");
    expect(failing(cleanInvoice({ fields: { subtotalCents: { value: 1, provenance: "ai" }, gstCents: printed(1), totalCents: printed(2) } }))).toContain("figures_printed");
    expect(failing(cleanInvoice({ totalsConsistent: false }))).toContain("totals_consistent");
    expect(failing(cleanInvoice({ totalsConsistent: null }))).toContain("totals_consistent");
  });
  it("needs a supplier invoice number and a recent date", () => {
    expect(failing(cleanInvoice({ supplierInvoiceNumber: null }))).toEqual(["invoice_number"]);
    expect(failing(cleanInvoice({ supplierInvoiceNumber: "  " }))).toEqual(["invoice_number"]);
    expect(failing(cleanInvoice({ invoiceDate: null }))).toEqual(["invoice_date"]);
    expect(failing(cleanInvoice({ invoiceDate: "2026-05-01" }))).toEqual(["invoice_date"]); // 144 days old
    expect(failing(cleanInvoice({ invoiceDate: "2026-10-30" }))).toEqual(["invoice_date"]); // in the future
    expect(failing(cleanInvoice({ invoiceDate: "2026-09-22" }))).toEqual([]);
  });
  it("trust is earned per supplier and can be revoked", () => {
    expect(failing(cleanInvoice(), ctx({ supplierHumanConfirmed: false }))).toEqual(["supplier_trusted"]);
    expect(failing(cleanInvoice(), ctx({ supplierAlwaysReview: true }))).toEqual(["supplier_not_flagged"]);
  });
  it("the cap is exclusive and applies to the ex-GST amount", () => {
    expect(failing(cleanInvoice({ subtotalCents: 499999 }))).toEqual([]);
    expect(failing(cleanInvoice({ subtotalCents: 500000 }))).toEqual(["under_cap"]);
    expect(failing(cleanInvoice({ subtotalCents: null }))).toEqual(["under_cap"]);
  });
  it("a credit note also needs a confirmed invoice from that supplier on the job", () => {
    expect(failing(cleanInvoice({ documentType: "credit_note" }))).toEqual([]);
    expect(failing(cleanInvoice({ documentType: "credit_note" }), ctx({ supplierConfirmedOnJob: false }))).toEqual(["credit_has_invoice"]);
  });
  it("anything a person touched or held stays with the person; duplicates never qualify", () => {
    expect(failing(cleanInvoice({ reviewedAt: "2026-09-21T00:00:00Z" }))).toEqual(["untouched"]);
    expect(failing(cleanInvoice({ heldAt: "2026-09-21T00:00:00Z" }))).toEqual(["untouched"]);
    expect(failing(cleanInvoice({ duplicateOfId: "x" }))).toEqual(["not_duplicate"]);
  });
  it("every check carries office wording", () => {
    for (const c of evaluateAutoConfirm(cleanInvoice({ documentType: "credit_note" }), ctx()).checks) expect(c.label, c.code).toBeTruthy();
  });
  it("deadline and actor", () => {
    expect(autoConfirmDeadline(12, new Date("2026-09-22T00:00:00Z"))).toBe("2026-09-22T12:00:00.000Z");
    expect(autoConfirmDeadline(0, new Date("2026-09-22T00:00:00Z"))).toBe("2026-09-22T01:00:00.000Z"); // floor of 1h
    expect(AUTO_ACTOR).toEqual({ id: "__auto__", name: "BuhlOS (auto)", role: "system" });
  });
});

describe("buildDigest", () => {
  const base = { weekLabel: "week to 22 Sep", capturedCount: 5, autoBooked: [], humanBooked: [], pending: [], bookingSoon: [], failedCount: 0, stuckCount: 0, lastReceivedAt: new Date().toISOString(), everReceived: true, inboxUrl: "https://buhlos.com/invoices" };
  it("summarises the week and says all good when it is", () => {
    const d = buildDigest({ ...base, autoBooked: [{ id: "1", supplierName: "Sparky", supplierInvoiceNumber: "SS-1", jobLabel: "IV3232 · Birdwood", amountCents: 108000, url: "https://buhlos.com/invoices/1" }] });
    expect(d.subject).toContain("1 booked automatically, 0 waiting on you");
    expect(d.attention).toBe(false);
    expect(d.text).toContain("Sparky · SS-1 · IV3232 · Birdwood · $1,080.00");
    expect(d.text).toContain("Health: all good.");
    expect(d.html).toContain('<a href="https://buhlos.com/invoices/1">');
    expect(d.html).not.toContain("<script");
  });
  it("raises attention for failures, stuck rows and silence", () => {
    const stale = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const d = buildDigest({ ...base, failedCount: 2, stuckCount: 1, lastReceivedAt: stale });
    expect(d.attention).toBe(true);
    expect(d.subject).toContain("attention needed");
    expect(d.text).toMatch(/2 document\(s\) could not be read/);
    expect(d.text).toMatch(/waited more than a day/);
    expect(d.text).toMatch(/No supplier email has arrived for 20 days/);
    expect(buildDigest({ ...base, lastReceivedAt: null, everReceived: false }).text).toMatch(/has ever arrived/);
  });
  it("escapes supplier text in the html", () => {
    const d = buildDigest({ ...base, pending: [{ id: "2", supplierName: "<b>Evil</b>", supplierInvoiceNumber: "1", matchedJobId: "j", amountCents: 100 }] });
    expect(d.html).toContain("&lt;b&gt;Evil&lt;/b&gt;");
  });
});
