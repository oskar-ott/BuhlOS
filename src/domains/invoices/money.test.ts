import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const requireFromHere = createRequire(import.meta.url);
const money = requireFromHere("../../../api/_lib/invoices/money.js");
const dedupe = requireFromHere("../../../api/_lib/invoices/dedupe.js");
const state = requireFromHere("../../../api/_lib/invoices/state.js");
const supplier = requireFromHere("../../../api/_lib/invoices/supplier-identity.js");
const safe = requireFromHere("../../../api/_lib/invoices/safe-file.js");

describe("money — integer cents only", () => {
  it("parses printed amounts to integer cents", () => {
    expect(money.parseMoneyToCents("$1,234.56")).toBe(123456);
    expect(money.parseMoneyToCents("1234")).toBe(123400);
    expect(money.parseMoneyToCents("12.5")).toBe(1250);
    expect(money.parseMoneyToCents("AUD 12.00")).toBe(1200);
    expect(money.parseMoneyToCents("(12.00)")).toBe(-1200);
    expect(money.parseMoneyToCents("12.00 CR")).toBe(-1200);
    expect(money.parseMoneyToCents("-0.01")).toBe(-1);
  });
  it("returns null for anything ambiguous instead of guessing", () => {
    for (const bad of ["", "abc", "1.234", "12.345", "1,23", null, undefined, "$", "1e5"]) {
      expect(money.parseMoneyToCents(bad), String(bad)).toBeNull();
    }
    expect(Number.isInteger(money.parseMoneyToCents("0.10"))).toBe(true);
  });
  it("reconciles three figures and flags a 1-cent+ mismatch", () => {
    expect(money.reconcileTotals({ subtotalCents: 108000, gstCents: 10800, totalCents: 118800 })).toMatchObject({ consistent: true, derived: [] });
    expect(money.reconcileTotals({ subtotalCents: 10000, gstCents: 1000, totalCents: 12100 })).toMatchObject({ consistent: false, deltaCents: -1100 });
    expect(money.reconcileTotals({ subtotalCents: 10000, gstCents: 1000, totalCents: 11001 })).toMatchObject({ consistent: true });
  });
  it("derives the third figure by arithmetic only — never assumes 10%", () => {
    expect(money.reconcileTotals({ subtotalCents: 20000, totalCents: 22000 })).toMatchObject({ gstCents: 2000, derived: ["gst"], consistent: true });
    expect(money.reconcileTotals({ subtotalCents: 20000, totalCents: 20300 })).toMatchObject({ gstCents: 300, derived: ["gst"] }); // GST-free lines
    expect(money.reconcileTotals({ subtotalCents: 20000, gstCents: 2000 })).toMatchObject({ totalCents: 22000, derived: ["total"] });
    expect(money.reconcileTotals({ gstCents: 2000, totalCents: 22000 })).toMatchObject({ subtotalCents: 20000, derived: ["subtotal"] });
    expect(money.reconcileTotals({ totalCents: 11000 })).toMatchObject({ subtotalCents: null, gstCents: null, consistent: null, derived: [] });
    expect(money.reconcileTotals({ subtotalCents: 30000, totalCents: 22000 })).toMatchObject({ consistent: false });
  });
  it("signs allocations by document type and refuses non-allocatable types", () => {
    expect(money.allocationAmountCents("tax_invoice", 108000)).toBe(108000);
    expect(money.allocationAmountCents("invoice", 5)).toBe(5);
    expect(money.allocationAmountCents("credit_note", 12000)).toBe(-12000);
    expect(money.allocationAmountCents("statement", 100)).toBeNull();
    expect(money.allocationAmountCents("quote", 100)).toBeNull();
    expect(money.allocationAmountCents("unknown", 100)).toBeNull();
    expect(money.allocationAmountCents("tax_invoice", null)).toBeNull();
    expect(money.allocationAmountCents("tax_invoice", 10.5)).toBeNull();
  });
});

describe("dedupe — provider identity, checksum, supplier + number", () => {
  it("prefers the checksum rule and picks the earliest original", () => {
    const d = dedupe.decideDuplicate({
      sha256: "abc",
      byChecksum: [{ id: "b", status: "matched", createdAt: "2026-09-02" }, { id: "a", status: "confirmed", createdAt: "2026-09-01" }],
    });
    expect(d).toEqual({ duplicate: true, ofId: "a", reason: "checksum" });
  });
  it("matches supplier + invoice number only when both are known", () => {
    const rows = [{ id: "x", status: "confirmed", createdAt: "2026-09-01" }];
    expect(dedupe.decideDuplicate({ supplierKey: "sparky supplies", supplierInvoiceNumber: "ss-88123", bySupplierNumber: rows })).toEqual({ duplicate: true, ofId: "x", reason: "supplier_invoice_number" });
    expect(dedupe.decideDuplicate({ supplierKey: null, supplierInvoiceNumber: "ss-88123", bySupplierNumber: rows })).toEqual({ duplicate: false });
    expect(dedupe.decideDuplicate({ supplierKey: "sparky supplies", supplierInvoiceNumber: null, bySupplierNumber: rows })).toEqual({ duplicate: false });
  });
  it("ignores rows that are themselves duplicates", () => {
    expect(dedupe.decideDuplicate({ sha256: "abc", byChecksum: [{ id: "d", status: "duplicate" }] })).toEqual({ duplicate: false });
  });
  it("normalises invoice numbers for comparison", () => {
    expect(dedupe.normaliseInvoiceNumber(" ss 88123 ")).toBe("SS88123");
    expect(dedupe.normaliseInvoiceNumber("")).toBeNull();
  });
});

describe("state machine", () => {
  it("allows only the documented transitions", () => {
    expect(state.canTransition("matched", "confirm")).toBe(true);
    expect(state.canTransition("needs_review", "confirm")).toBe(true);
    expect(state.canTransition("confirmed", "confirm")).toBe(false);
    expect(state.canTransition("duplicate", "confirm")).toBe(false);
    expect(state.canTransition("excluded", "confirm")).toBe(false);
    expect(state.canTransition("confirmed", "exclude")).toBe(true);
    expect(state.canTransition("confirmed", "reassign")).toBe(true);
    expect(state.canTransition("matched", "reassign")).toBe(false);
    expect(state.canTransition("archived", "restore")).toBe(true);
    expect(state.canTransition("confirmed", "restore")).toBe(false);
    expect(state.canTransition("failed", "retry")).toBe(true);
    expect(state.canTransition("confirmed", "retry")).toBe(false);
    expect(state.canTransition("bogus", "confirm")).toBe(false);
  });
  it("every review reason has office wording", () => {
    for (const code of ["no_iv_reference", "iv_not_found", "iv_ambiguous", "multi_reference", "totals_inconsistent", "missing_subtotal", "unknown_document_type", "not_allocatable", "no_text_layer"]) {
      expect(state.REVIEW_REASON_LABELS[code], code).toBeTruthy();
    }
  });
});

describe("supplier identity", () => {
  it("keys the same supplier printed different ways to one value", () => {
    const a = supplier.normaliseSupplierName("L&H Group Pty Ltd");
    expect(a).toBe("l and h");
    expect(supplier.normaliseSupplierName("L & H GROUP PTY. LTD.")).toBe(a);
    expect(supplier.normaliseSupplierName("l&h group")).toBe(a);
    expect(supplier.normaliseSupplierName("Pty Ltd")).toBeNull();
  });
  it("extracts only checksum-valid ABNs", () => {
    expect(supplier.extractAbn("ABN 51 824 753 556")).toBe("51824753556");
    expect(supplier.extractAbn("A.B.N. 51-824-753-556")).toBe("51824753556");
    expect(supplier.extractAbn("ABN 11 111 111 111")).toBeNull();
    expect(supplier.isValidAbn("51824753556")).toBe(true);
  });
});

describe("safe file handling", () => {
  it("strips paths and control characters, bounds length, forces .pdf", () => {
    expect(safe.sanitiseFilename("../../etc/passwd")).toBe("passwd.pdf");
    expect(safe.sanitiseFilename("C:\\Users\\x\\inv.PDF")).toBe("inv.PDF");
    expect(safe.sanitiseFilename("evil\u0000name.exe")).toBe("evilname.pdf");
    expect(safe.sanitiseFilename("")).toBe("invoice.pdf");
    expect(safe.sanitiseFilename(".hidden")).toBe("hidden.pdf");
    expect(safe.sanitiseFilename("x".repeat(300) + ".pdf").length).toBeLessThanOrEqual(120);
  });
  it("sniffs PDF bytes rather than trusting the name", () => {
    expect(safe.isPdfBuffer(Buffer.from("%PDF-1.7\n%âãÏÓ"))).toBe(true);
    expect(safe.isPdfBuffer(Buffer.from("junk\n%PDF-1.4"))).toBe(true);
    expect(safe.isPdfBuffer(Buffer.from("MZ this is an exe pretending.pdf"))).toBe(false);
    expect(safe.isPdfBuffer(Buffer.from(""))).toBe(false);
  });
  it("decodes data URLs and bounds size before allocating", () => {
    const pdf = Buffer.from("%PDF-1.4 tiny");
    expect(safe.decodeDataUrl(`data:application/pdf;base64,${pdf.toString("base64")}`, 1000)).toEqual({ bytes: pdf });
    expect(safe.decodeDataUrl(pdf.toString("base64"), 1000)).toEqual({ bytes: pdf });
    expect(safe.decodeDataUrl(`data:application/pdf;base64,${Buffer.alloc(2000).toString("base64")}`, 1000)).toEqual({ tooLarge: true });
    expect(safe.decodeDataUrl("", 1000)).toBeNull();
    expect(safe.decodeDataUrl("data:application/pdf;base64,", 1000)).toBeNull();
  });
});
