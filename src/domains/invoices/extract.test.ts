import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import * as F from "./test-helpers/fixtures";

const requireFromHere = createRequire(import.meta.url);
const { extractInvoiceFromText, parseDate } = requireFromHere("../../../api/_lib/invoices/extract.js");
const { decideMatch } = requireFromHere("../../../api/_lib/invoices/pipeline.js");

/**
 * Rule-based extraction over FAKE fixture text. These pin the label
 * vocabulary and the honesty rules (nulls, provenance, no 10% assumption);
 * real supplier samples are still required to validate layouts.
 */
describe("extractInvoiceFromText — a standard tax invoice", () => {
  const e = extractInvoiceFromText(F.TAX_INVOICE_IV0041);
  it("classifies, reads the supplier, ABN, number and date", () => {
    expect(e.documentType).toBe("tax_invoice");
    expect(e.supplierName).toBe("Sparky Supplies Pty Ltd");
    expect(e.supplierAbn).toBe("51824753556");
    expect(e.supplierInvoiceNumber).toBe("SS-88123");
    expect(e.invoiceDate).toBe("2026-09-03");
  });
  it("reads the three figures as integer cents and reconciles them", () => {
    expect(e.subtotalCents).toBe(108000);
    expect(e.gstCents).toBe(10800);
    expect(e.totalCents).toBe(118800);
    expect(e.totalsConsistent).toBe(true);
    expect(e.totalsDerived).toEqual([]);
  });
  it("keeps the supplier invoice number and the IV job reference apart", () => {
    expect(e.ivSelection).toMatchObject({ outcome: "selected", normalised: "IV0041", label: "Job Number" });
    expect(e.supplierInvoiceNumber).not.toBe("IV0041");
    expect(e.fields.ivReference.provenance).toBe("pdf_text");
    expect(e.fields.supplierInvoiceNumber.label).toMatch(/Tax Invoice No/i);
  });
});

describe("extractInvoiceFromText — document types", () => {
  it("recognises a credit note (magnitudes positive, sign applied later)", () => {
    const e = extractInvoiceFromText(F.CREDIT_NOTE_IV0041);
    expect(e.documentType).toBe("credit_note");
    expect(e.supplierInvoiceNumber).toBe("CN-2001");
    expect(e.subtotalCents).toBe(12000);
    expect(e.totalCents).toBe(13200);
    expect(e.ivSelection.normalised).toBe("IV0041");
  });
  it("recognises a statement and a quote", () => {
    expect(extractInvoiceFromText(F.STATEMENT).documentType).toBe("statement");
    const q = extractInvoiceFromText(F.QUOTE);
    expect(q.documentType).toBe("quote");
    expect(q.ivSelection.normalised).toBe("IV0042");
  });
  it("returns unknown for an unrecognisable document", () => {
    const e = extractInvoiceFromText("Some letter\nDear customer\nThanks");
    expect(e.documentType).toBe("unknown");
    expect(e.supplierInvoiceNumber).toBeNull();
    expect(e.subtotalCents).toBeNull();
  });
});

describe("extractInvoiceFromText — honesty cases", () => {
  it("flags inconsistent totals instead of correcting them", () => {
    const e = extractInvoiceFromText(F.INVOICE_GST_INCONSISTENT);
    expect(e.totalsConsistent).toBe(false);
    expect(e.totalsDeltaCents).toBe(-1100);
  });
  it("leaves the subtotal null when only a total is printed", () => {
    const e = extractInvoiceFromText(F.INVOICE_MISSING_SUBTOTAL);
    expect(e.subtotalCents).toBeNull();
    expect(e.gstCents).toBeNull();
    expect(e.totalCents).toBe(11000);
    expect(e.totalsConsistent).toBeNull();
  });
  it("derives GST from two printed figures and says so", () => {
    const e = extractInvoiceFromText(F.INVOICE_TWO_OF_THREE);
    expect(e.subtotalCents).toBe(20000);
    expect(e.totalCents).toBe(22000);
    expect(e.gstCents).toBe(2000);
    expect(e.fields.gstCents.provenance).toBe("derived");
    expect(e.invoiceDate).toBe("2026-09-10");
    expect(e.ivSelection).toMatchObject({ normalised: "IV0041", label: "Customer Ref" });
  });
  it("reports several references and a malformed reference honestly", () => {
    expect(extractInvoiceFromText(F.INVOICE_MULTI_REFERENCE).ivSelection.outcome).toBe("multi_reference");
    expect(extractInvoiceFromText(F.INVOICE_MALFORMED_REF).ivSelection.outcome).toBe("none");
  });
  it("never reads 'Invoice Date' as the invoice number", () => {
    const e = extractInvoiceFromText("TAX INVOICE\nInvoice Date: 12/03/2026\nInvoice No: 777\nTotal 1.00");
    expect(e.supplierInvoiceNumber).toBe("777");
    expect(e.invoiceDate).toBe("2026-03-12");
  });
  it("never uses a due / delivery date as the invoice date", () => {
    const e = extractInvoiceFromText("TAX INVOICE\nInvoice No: 1\nDue Date: 30/09/2026\nTotal 1.00");
    expect(e.invoiceDate).toBeNull();
  });
});

describe("parseDate — day first", () => {
  it("parses Australian formats", () => {
    expect(parseDate("03/09/2026")).toBe("2026-09-03");
    expect(parseDate("3-9-26")).toBe("2026-09-03");
    expect(parseDate("10 Sep 2026")).toBe("2026-09-10");
    expect(parseDate("10 September 2026")).toBe("2026-09-10");
    expect(parseDate("Sep 10, 2026")).toBe("2026-09-10");
    expect(parseDate("2026-09-10")).toBe("2026-09-10");
    expect(parseDate("31/02/2026")).toBeNull();
    expect(parseDate("nonsense")).toBeNull();
  });
});

describe("decideMatch — extraction → match + review reasons", () => {
  it("exact match, clean invoice → no reasons", () => {
    const d = decideMatch(extractInvoiceFromText(F.TAX_INVOICE_IV0041), F.JOBS);
    expect(d.matchStatus).toBe("exact");
    expect(d.matchedJob.id).toBe("birdwood");
    expect(d.reasons).toEqual([]);
    expect(d.matchReason).toMatchObject({ raw: "IV 0041", normalised: "IV0041", label: "Job Number", source: "labelled", field: "jobs.json code", matchCount: 1 });
  });
  it("an unknown IV reference goes to review", () => {
    const d = decideMatch(extractInvoiceFromText(F.INVOICE_UNKNOWN_IV), F.JOBS);
    expect(d.matchStatus).toBe("not_found");
    expect(d.reasons).toEqual(["iv_not_found"]);
  });
  it("no reference / several references / malformed reference go to review", () => {
    expect(decideMatch(extractInvoiceFromText(F.INVOICE_NO_REFERENCE), F.JOBS).reasons).toContain("no_iv_reference");
    expect(decideMatch(extractInvoiceFromText(F.INVOICE_MULTI_REFERENCE), F.JOBS).reasons).toContain("multi_reference");
    expect(decideMatch(extractInvoiceFromText(F.INVOICE_MALFORMED_REF), F.JOBS).reasons).toContain("no_iv_reference");
  });
  it("a code carried by two live jobs blocks automatic matching", () => {
    const d = decideMatch(extractInvoiceFromText(F.TAX_INVOICE_IV0041), [...F.JOBS, { id: "clash", name: "Clash", code: "IV0041" }]);
    expect(d.matchStatus).toBe("ambiguous");
    expect(d.reasons).toEqual(["iv_ambiguous"]);
    expect(d.collisions).toEqual(["IV0041"]);
  });
  it("a completed job still matches, with a warning for the reviewer", () => {
    const d = decideMatch(extractInvoiceFromText(F.QUOTE), F.JOBS);
    expect(d.matchStatus).toBe("exact");
    expect(d.matchReason.warnings).toEqual(["job is complete — late invoice?"]);
    expect(d.reasons).toEqual(["not_allocatable"]); // quotes never become costs
  });
  it("statements, inconsistent totals and missing subtotals require review", () => {
    expect(decideMatch(extractInvoiceFromText(F.STATEMENT), F.JOBS).reasons).toContain("not_allocatable");
    expect(decideMatch(extractInvoiceFromText(F.INVOICE_GST_INCONSISTENT), F.JOBS).reasons).toEqual(["totals_inconsistent"]);
    expect(decideMatch(extractInvoiceFromText(F.INVOICE_MISSING_SUBTOTAL), F.JOBS).reasons).toEqual(["missing_subtotal"]);
  });
});
