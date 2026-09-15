import { describe, expect, it } from "vitest";
import { centsToDollarsInput, dollarsInputToCents, formatCentsExact, signedCostCents, statusLabel, statusTone } from "./format";
import { InvoiceSchema } from "./schema";

describe("invoice formatters", () => {
  it("formats cents exactly and parses dollar input back to integer cents", () => {
    expect(formatCentsExact(108000)).toBe("$1,080.00");
    expect(formatCentsExact(-1200)).toBe("-$12.00");
    expect(formatCentsExact(null)).toBe("—");
    expect(dollarsInputToCents("$1,080.00")).toBe(108000);
    expect(dollarsInputToCents("184.5")).toBe(18450);
    expect(dollarsInputToCents("184")).toBe(18400);
    expect(dollarsInputToCents("")).toBeNull();
    expect(dollarsInputToCents("12.345")).toBeNull();
    expect(dollarsInputToCents("abc")).toBeNull();
    expect(centsToDollarsInput(18450)).toBe("184.50");
  });
  it("signs the cost by document type", () => {
    expect(signedCostCents({ documentType: "credit_note", subtotalCents: 500 })).toBe(-500);
    expect(signedCostCents({ documentType: "tax_invoice", subtotalCents: 500 })).toBe(500);
    expect(signedCostCents({ documentType: "statement", subtotalCents: 500 })).toBeNull();
  });
  it("labels every status with a tone", () => {
    expect(statusLabel("matched")).toBe("Matched — awaiting confirmation");
    expect(statusTone("confirmed")).toBe("success");
    expect(statusTone("failed")).toBe("danger");
  });
  it("the invoice schema keeps supplier invoice number and IV reference as separate fields", () => {
    const parsed = InvoiceSchema.parse({
      id: "x", status: "matched", source: "upload", documentType: "tax_invoice", supplierName: "S", supplierKey: "s", supplierAbn: null,
      supplierInvoiceNumber: "SS-1", invoiceDate: "2026-09-03", currency: "AUD", subtotalCents: 100, gstCents: 10, totalCents: 110, totalsConsistent: true,
      ivReferenceRaw: "IV 0041", ivReference: "IV0041", ivCandidates: [], matchedJobId: "j", matchStatus: "exact", matchReason: null, reviewReasons: [],
      failureCode: null, extractionMethod: "pdf_text", fields: {}, excerpt: null, attemptCount: 1, duplicateOfId: null, duplicateReason: null,
      sourceEmailId: null, sourceSubject: null, sourceFrom: null, createdBy: null, reviewedAt: null, reviewedBy: null, confirmedAt: null, confirmedBy: null,
      excludedReason: null, archivedAt: null, createdAt: null, updatedAt: null,
    });
    expect(parsed.supplierInvoiceNumber).toBe("SS-1");
    expect(parsed.ivReference).toBe("IV0041");
    expect(() => InvoiceSchema.parse({ id: "x" })).toThrow();
  });
});
