import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * "Possible duplicate cost" (2026-09-27) — the pure matcher behind
 * api/job-materials.js: a docket typed into the manual ledger vs the CONFIRMED
 * supplier invoices already booked on the job. The rules, each proven here:
 *   - the supplier must match (by the invoice pipeline's own lookup key);
 *   - supplier + supplier-invoice number is the strongest signal;
 *   - supplier + same amount within 14 days is a weaker one;
 *   - equal amounts alone are never a duplicate;
 *   - credit notes (negative) never match a positive docket;
 *   - reused invoice numbers across suppliers never collide.
 * Reversed / excluded documents never reach the matcher at all (the store only
 * returns active allocations on confirmed invoices).
 */
const requireFromHere = createRequire(import.meta.url);

type Allocation = {
  invoiceId: string;
  amountCents: number;
  confirmedAt: string | null;
  supplierName: string | null;
  supplierKey: string | null;
  supplierInvoiceNumber: string | null;
  invoiceDate: string | null;
  documentType: string | null;
};
type Candidate = { invoiceId: string; strength: "reference" | "amount_date"; reasons: string[] };
type Input = { date: string; supplier: string; amountCents: number; reference?: string | null };

const lib = requireFromHere("../../../api/_lib/job-materials.js") as {
  findPossibleDuplicates: (input: Input, allocations: Allocation[], opts?: { windowDays?: number }) => Candidate[];
  referencesMatch: (a: string, b: string) => boolean;
  normaliseReference: (r: string) => string;
  parseOverride: (body: unknown) => null | { reason: string } | { error: string };
  validateLineInput: (body: unknown) => { ok: true; value: Input } | { ok: false; error: string };
  DUPLICATE_WINDOW_DAYS: number;
  REFERENCE_MAX: number;
};

function alloc(over: Partial<Allocation> = {}): Allocation {
  return {
    invoiceId: "inv-1",
    amountCents: 18450,
    confirmedAt: "2026-09-20T03:00:00.000Z",
    supplierName: "L & H Group Pty Ltd",
    supplierKey: "l and h",
    supplierInvoiceNumber: "INV-00482",
    invoiceDate: "2026-09-18",
    documentType: "invoice",
    ...over,
  };
}
const typed: Input = { date: "2026-09-19", supplier: "L&H", amountCents: 18450, reference: null };

describe("findPossibleDuplicates — rules", () => {
  it("same supplier + same invoice number → 'reference' (even when the amount differs)", () => {
    const out = lib.findPossibleDuplicates({ ...typed, amountCents: 20000, reference: "inv 00482" }, [alloc()]);
    expect(out.map((c) => c.strength)).toEqual(["reference"]);
    expect(out[0]?.reasons).toEqual(["same supplier", "same invoice number", "different amount"]);
  });

  it("same supplier + same amount within the window → 'amount_date'; outside the window → nothing", () => {
    expect(lib.findPossibleDuplicates(typed, [alloc()]).map((c) => c.strength)).toEqual(["amount_date"]);
    expect(lib.findPossibleDuplicates({ ...typed, date: "2026-11-01" }, [alloc()])).toEqual([]);
    expect(lib.DUPLICATE_WINDOW_DAYS).toBe(14);
  });

  it("equal amounts alone are never a duplicate — a different supplier is a different cost", () => {
    expect(lib.findPossibleDuplicates({ ...typed, supplier: "Bunnings" }, [alloc()])).toEqual([]);
  });

  it("a reused invoice number at a different supplier never collides", () => {
    expect(
      lib.findPossibleDuplicates({ ...typed, supplier: "Bunnings", reference: "INV-00482" }, [alloc()]),
    ).toEqual([]);
  });

  it("a credit note (negative, or typed credit_note) never matches a positive docket", () => {
    expect(lib.findPossibleDuplicates({ ...typed, reference: "482" }, [alloc({ amountCents: -18450 })])).toEqual([]);
    expect(
      lib.findPossibleDuplicates({ ...typed, reference: "482" }, [alloc({ documentType: "credit_note", amountCents: 18450 })]),
    ).toEqual([]);
  });

  it("supplier identity is the pipeline's lookup key: suffixes, punctuation and case are ignored", () => {
    const a = alloc({ supplierKey: null, supplierName: "L & H GROUP PTY. LTD." });
    expect(lib.findPossibleDuplicates({ ...typed, supplier: "l&h group" }, [a])).toHaveLength(1);
    expect(lib.findPossibleDuplicates({ ...typed, supplier: "" }, [a])).toEqual([]);
  });

  it("falls back to the confirmation date when the invoice carries no printed date", () => {
    const a = alloc({ invoiceDate: null, confirmedAt: "2026-09-19T00:00:00.000Z" });
    expect(lib.findPossibleDuplicates(typed, [a])).toHaveLength(1);
  });

  it("strongest first: a reference match outranks an amount match", () => {
    const out = lib.findPossibleDuplicates({ ...typed, reference: "INV-00999" }, [
      alloc({ invoiceId: "inv-amount" }),
      alloc({ invoiceId: "inv-ref", supplierInvoiceNumber: "INV-00999", amountCents: 1 }),
    ]);
    expect(out.map((c) => `${c.strength}:${c.invoiceId}`)).toEqual(["reference:inv-ref", "amount_date:inv-amount"]);
  });

  it("tolerates junk allocations without throwing", () => {
    expect(lib.findPossibleDuplicates(typed, [null as unknown as Allocation, {} as Allocation])).toEqual([]);
  });
});

describe("referencesMatch — normalisation", () => {
  it("ignores punctuation and case; matches the same trailing number of 4+ digits", () => {
    expect(lib.normaliseReference(" inv-00123 ")).toBe("INV00123");
    expect(lib.referencesMatch("INV-00482", "inv 00482")).toBe(true);
    expect(lib.referencesMatch("482", "INV-00482")).toBe(false); // 3 digits: exact only
    expect(lib.referencesMatch("1482", "INV-001482")).toBe(true);
    expect(lib.referencesMatch("D1482", "INV-001482")).toBe(true);
    expect(lib.referencesMatch("", "INV-00482")).toBe(false);
    expect(lib.referencesMatch("INV-00483", "INV-00482")).toBe(false);
  });
});

describe("parseOverride + reference validation", () => {
  it("no override → null; an override needs a reason of at least 3 characters; long reasons are clipped", () => {
    expect(lib.parseOverride({})).toBeNull();
    expect(lib.parseOverride({ override: null })).toBeNull();
    expect(lib.parseOverride({ override: "yes" })).toMatchObject({ error: expect.stringContaining("object") });
    expect(lib.parseOverride({ override: { reason: "  " } })).toMatchObject({ error: expect.stringContaining("reason") });
    expect(lib.parseOverride({ override: { reason: " cash sale docket " } })).toEqual({ reason: "cash sale docket" });
    const long = lib.parseOverride({ override: { reason: "x".repeat(500) } }) as { reason: string };
    expect(long.reason).toHaveLength(200);
  });

  it("reference is optional, trimmed, and capped", () => {
    const base = { date: "2026-09-19", supplier: "L&H", amountCents: 100 };
    const ok = lib.validateLineInput({ ...base, reference: " INV-1 " });
    expect(ok.ok && ok.value.reference).toBe("INV-1");
    const none = lib.validateLineInput(base);
    expect(none.ok && none.value.reference).toBeNull();
    const tooLong = lib.validateLineInput({ ...base, reference: "x".repeat(lib.REFERENCE_MAX + 1) });
    expect(tooLong.ok).toBe(false);
  });
});
