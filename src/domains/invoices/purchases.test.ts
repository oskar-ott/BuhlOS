import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { purchaseHeadline, purchaseLineLabel } from "./format";

const requireFromHere = createRequire(import.meta.url);
const { buildJobPurchases } = requireFromHere("../../../api/_lib/invoices/purchases.js");

const raw = {
  invoices: [
    { invoiceId: "i1", amountCents: 41550, confirmedAt: "2026-09-11T01:00:00Z", supplierName: "L&H", supplierInvoiceNumber: "WW-9", invoiceDate: "2026-09-10", documentType: "tax_invoice", source: "email", purchaser: "Tom", extraSecret: 123 },
    { invoiceId: "i2", amountCents: -1200, confirmedAt: "2026-09-12T01:00:00Z", supplierName: "L&H", supplierInvoiceNumber: "CN-1", invoiceDate: null, documentType: "credit_note", source: "email", purchaser: null },
    { invoiceId: "i3", amountCents: 990, confirmedAt: null, supplierName: null, supplierInvoiceNumber: null, invoiceDate: "2026-09-09", documentType: "tax_invoice", source: "receipt", purchaser: "Sam" },
  ],
  lines: [
    { invoiceId: "i1", description: "2.5MM TPS 100M ROLL", quantity: 3, unit: "roll", unitPriceCents: 8950, lineTotalCents: 26850, category: "cable" },
  ],
  totalCount: 7,
  totalCents: 99999,
};

describe("buildJobPurchases — the money is added for the office tier only", () => {
  it("without cost: whitelisted fields only — no amount, no total, no unit price, no unknown columns", () => {
    const out = buildJobPurchases(raw, { withCost: false, awaitingCount: 2 });
    expect(out.costVisible).toBe(false);
    expect(out).not.toHaveProperty("totalCents");
    expect(out.totalCount).toBe(7);
    expect(out.awaitingCount).toBe(2);
    for (const p of out.purchases) expect(p).not.toHaveProperty("amountCents");
    expect(Object.keys(out.purchases[0]).sort()).toEqual(["boughtBy", "date", "id", "kind", "lines", "supplier", "supplierInvoiceNumber"]);
    expect(Object.keys(out.purchases[0].lines[0]).sort()).toEqual(["category", "categoryLabel", "description", "measure", "quantity", "unit"]);
    expect(JSON.stringify(out)).not.toMatch(/8950|26850|41550|99999|extraSecret/);
  });
  it("with cost: each amount (a return negative) and the job total", () => {
    const out = buildJobPurchases(raw, { withCost: true });
    expect(out.costVisible).toBe(true);
    expect(out.totalCents).toBe(99999);
    expect(out.purchases.map((p: { amountCents: number }) => p.amountCents)).toEqual([41550, -1200, 990]);
  });
  it("names the kind in site words and falls back to the confirm date when no invoice date was read", () => {
    const out = buildJobPurchases(raw, { withCost: false });
    expect(out.purchases.map((p: { kind: string }) => p.kind)).toEqual(["invoice", "return", "receipt"]);
    expect(out.purchases[1].date).toBe("2026-09-12");
    expect(out.purchases[0].lines[0]).toMatchObject({ categoryLabel: "Cable", measure: { amount: 300, unit: "m" } });
    expect(out.purchases[1].lines).toEqual([]);
  });
});

describe("purchase wording", () => {
  it("leads with the quantity and adds metres only when they say something new", () => {
    expect(purchaseLineLabel({ description: "2.5MM TPS 100M ROLL", quantity: 3, unit: "roll", measure: { amount: 300, unit: "m" } })).toBe("3 × 2.5MM TPS 100M ROLL · 300 m");
    expect(purchaseLineLabel({ description: "TPS cable", quantity: 50, unit: "m", measure: { amount: 50, unit: "m" } })).toBe("50 × TPS cable");
    expect(purchaseLineLabel({ description: "9W LED DOWNLIGHT", quantity: 12, unit: "ea", measure: { amount: 12, unit: "pcs" } })).toBe("12 × 9W LED DOWNLIGHT");
    expect(purchaseLineLabel({ description: "Freight", quantity: null, unit: null, measure: { amount: null, unit: null } })).toBe("Freight");
    expect(purchaseLineLabel({ description: "Conduit", quantity: 2.5, unit: "len", measure: { amount: 2.5, unit: "len" } })).toBe("2.5 × Conduit");
  });
  it("headlines say where from, who bought it, and mark returns and receipts", () => {
    expect(purchaseHeadline({ supplier: "L&H", boughtBy: "Tom", kind: "invoice" })).toBe("L&H · Tom");
    expect(purchaseHeadline({ supplier: "L&H", boughtBy: null, kind: "return" })).toBe("Return · L&H");
    expect(purchaseHeadline({ supplier: "Bunnings", boughtBy: "Sam", kind: "receipt" })).toBe("Receipt · Bunnings · Sam");
    expect(purchaseHeadline({ supplier: null, boughtBy: "Sam", kind: "receipt" })).toBe("Receipt · Sam");
    expect(purchaseHeadline({ supplier: null, boughtBy: null, kind: "invoice" })).toBe("Supplier not read");
  });
});
