import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * api/_lib/customer-invoices/payload.js (#1150) — what goes to Xero and what
 * it must look like coming back. Pure. Pins the ADR's rules in the body
 * itself: DRAFT only, ContactID only, ex-GST lines, retention as a negative
 * line, integer cents in and out.
 */
const requireFromHere = createRequire(import.meta.url);
const P = requireFromHere("../../../api/_lib/customer-invoices/payload.js");

const job = { id: "tower", name: "Tower Fit-out", code: "IV3345", siteAddress: "12 Smith St, Sydney", contractValue: 250000 };
const profile = { retentionBp: 0, xeroContactId: "c-built", xeroContactName: "Built Pty Ltd", externalTenantId: "org-1" };
const settings = { salesAccountCode: "200", salesAccountName: "Sales", taxType: "OUTPUT", taxName: "GST on Income", taxRateBp: 1000, paymentTermsDays: 30 };
const ready = { state: "connected", externalTenantId: "org-1", organisationName: "Buhl Electrical" };
const stage = (over: Record<string, unknown> = {}) => ({
  id: "s1", kind: "stage", state: "planned", title: "Deposit", basis: "percent", percentBp: 2000, amountCents: null, extraLines: [], retentionBp: null, ...over,
});
const ctx = (over: Record<string, unknown> = {}) => ({
  stage: stage(), job, profile, settings, ready, settingsComplete: true, contractCents: 250_000_00, ...over,
});
const codes = (c: Record<string, unknown>) => P.blockersFor(c).map((b: { code: string }) => b.code);

describe("blockersFor", () => {
  it("nothing blocks a planned stage on a fully set-up job", () => {
    expect(codes(ctx())).toEqual([]);
  });

  it("names each thing that stops a send", () => {
    expect(codes(ctx({ stage: stage({ state: "sent" }) }))).toContain("not_planned");
    expect(codes(ctx({ ready: { state: "missing_permission", externalTenantId: "org-1" } }))).toContain("xero_not_ready");
    expect(codes(ctx({ settingsComplete: false }))).toContain("settings_incomplete");
    expect(codes(ctx({ profile: { ...profile, xeroContactId: null } }))).toContain("no_client_link");
    expect(codes(ctx({ profile: null }))).toContain("no_client_link");
    expect(codes(ctx({ profile: { ...profile, externalTenantId: "org-2" } }))).toEqual(["client_other_organisation"]);
    expect(codes(ctx({ job: { ...job, code: undefined } }))).toContain("no_job_code");
    expect(codes(ctx({ job: { ...job, code: "3345" } }))).toContain("no_job_code");
    expect(codes(ctx({ contractCents: null }))).toEqual(["no_contract_value"]);
    expect(codes(ctx({ stage: stage({ basis: "amount", percentBp: null, amountCents: null }) }))).toEqual(["amount_invalid"]);
  });

  it("refuses a stage with nothing left to invoice after retention", () => {
    expect(codes(ctx({ stage: stage({ retentionBp: 10000 }) }))).toEqual(["nothing_to_invoice"]);
  });

  it("can report several blockers at once", () => {
    const all = codes(ctx({ ready: { state: "disconnected", externalTenantId: null }, settingsComplete: false, profile: null, contractCents: null }));
    expect(all).toEqual(["xero_not_ready", "settings_incomplete", "no_client_link", "no_contract_value"]);
  });
});

describe("composeInvoice", () => {
  it("a % stage: one line worded with the percentage, the job and the site", () => {
    const c = P.composeInvoice({ ...ctx(), invoiceDate: "2026-11-22" });
    expect(c.lines).toEqual([{ description: "Deposit (20% of contract)\nTower Fit-out, 12 Smith St, Sydney", amountCents: 50_000_00 }]);
    expect(c).toMatchObject({ grossCents: 50_000_00, retentionCents: 0, netCents: 50_000_00, invoiceDate: "2026-11-22", dueDate: "2026-12-22", reference: "IV3345 Tower Fit-out", estimatedTaxCents: 5_000_00 });
  });

  it("a dollar stage with extra lines and retention: retention is a NEGATIVE line on the gross", () => {
    const c = P.composeInvoice({
      ...ctx({ stage: stage({ title: "November claim", basis: "amount", percentBp: null, amountCents: 12_000_50, extraLines: [{ description: "Variation 3", amountCents: 1_200_00 }] }), profile: { ...profile, retentionBp: 500 } }),
      invoiceDate: "2026-11-30",
    });
    expect(c.lines).toEqual([
      { description: "November claim\nTower Fit-out, 12 Smith St, Sydney", amountCents: 12_000_50 },
      { description: "Variation 3", amountCents: 1_200_00 },
      { description: "Less retention (5%)", amountCents: -660_03 },
    ]);
    expect(c.netCents).toBe(12_540_47);
    expect(c.lines.reduce((s: number, l: { amountCents: number }) => s + l.amountCents, 0)).toBe(c.netCents);
    expect(c.estimatedTaxCents).toBe(1_254_05); // 10% of 12,540.47 = 1,254.047 → 1,254.05
  });

  it("a retention release has no retention taken off and no percentage wording", () => {
    const c = P.composeInvoice({ ...ctx({ stage: stage({ kind: "retention_release", title: "Retention release", basis: "amount", percentBp: null, amountCents: 2_500_00 }), profile: { ...profile, retentionBp: 500 } }), invoiceDate: "2027-03-01" });
    expect(c.lines).toEqual([{ description: "Retention release\nTower Fit-out, 12 Smith St, Sydney", amountCents: 2_500_00 }]);
    expect(c.netCents).toBe(2_500_00);
  });

  it("due date is the invoice date plus the terms — across a month and a leap day; 0 days is the same day", () => {
    const due = (invoiceDate: string, days: number) => P.composeInvoice({ ...ctx({ settings: { ...settings, paymentTermsDays: days } }), invoiceDate }).dueDate;
    expect(due("2026-11-22", 30)).toBe("2026-12-22");
    expect(due("2028-02-15", 14)).toBe("2028-02-29");
    expect(due("2026-12-20", 14)).toBe("2027-01-03");
    expect(due("2026-11-22", 0)).toBe("2026-11-22");
  });

  it("uses a typed reference when given, the job code and name otherwise, capped at 255", () => {
    expect(P.composeInvoice({ ...ctx(), invoiceDate: "2026-11-22", reference: "  PO 7781 / Claim 3 " }).reference).toBe("PO 7781 / Claim 3");
    expect(P.composeInvoice({ ...ctx(), invoiceDate: "2026-11-22", reference: "   " }).reference).toBe("IV3345 Tower Fit-out");
    expect(P.composeInvoice({ ...ctx(), invoiceDate: "2026-11-22", reference: "x".repeat(400) }).reference).toHaveLength(255);
  });

  it("is null when the amount can't be worked out", () => {
    expect(P.composeInvoice({ ...ctx({ contractCents: null }), invoiceDate: "2026-11-22" })).toBeNull();
  });
});

describe("composeFromSnapshot — a retry uses what was frozen, never a re-derived amount", () => {
  it("rebuilds the same lines from the stored row, whatever the contract is now", () => {
    const first = P.composeInvoice({ ...ctx({ profile: { ...profile, retentionBp: 500 }, stage: stage({ extraLines: [{ description: "Variation 1", amountCents: 1_000_00 }] }) }), invoiceDate: "2026-11-22" });
    const row = {
      ...stage({ extraLines: [{ description: "Variation 1", amountCents: 1_000_00 }] }), state: "sending",
      grossCents: first.grossCents, retentionBp: 500, retentionCents: first.retentionCents, netCents: first.netCents,
      invoiceDate: first.invoiceDate, dueDate: first.dueDate, reference: first.reference,
    };
    const again = P.composeFromSnapshot(row, job);
    expect(again.lines).toEqual(first.lines);
    expect(again).toMatchObject({ netCents: first.netCents, invoiceDate: "2026-11-22", dueDate: "2026-12-22", reference: "IV3345 Tower Fit-out" });
  });

  it("is null for a row with no frozen figures", () => {
    expect(P.composeFromSnapshot({ ...stage(), grossCents: null, netCents: null }, job)).toBeNull();
  });
});

describe("buildXeroBody", () => {
  const composed = P.composeInvoice({
    ...ctx({ stage: stage({ title: "November claim", basis: "amount", percentBp: null, amountCents: 12_000_50 }), profile: { ...profile, retentionBp: 500 } }),
    invoiceDate: "2026-11-30",
  });
  const body = P.buildXeroBody({ invoiceNumber: "IV3345-2", contactId: "c-built", composed, settings, url: "https://buhlos.com/v2/jobs/tower" });
  const inv = body.Invoices[0];

  it("is one DRAFT sales invoice, ex GST, with the job-and-stage number", () => {
    expect(body.Invoices).toHaveLength(1);
    expect(inv).toMatchObject({
      Type: "ACCREC", Status: "DRAFT", LineAmountTypes: "Exclusive", InvoiceNumber: "IV3345-2",
      Reference: "IV3345 Tower Fit-out", Date: "2026-11-30", DueDate: "2026-12-30", Url: "https://buhlos.com/v2/jobs/tower",
    });
  });

  it("sends ONLY the ContactID — anything more would edit the contact in Xero", () => {
    expect(inv.Contact).toEqual({ ContactID: "c-built" });
  });

  it("codes every line to the chosen account and tax rate, in dollars to the cent", () => {
    expect(inv.LineItems).toEqual([
      { Description: "November claim\nTower Fit-out, 12 Smith St, Sydney", Quantity: 1, UnitAmount: 12000.5, AccountCode: "200", TaxType: "OUTPUT" },
      { Description: "Less retention (5%)", Quantity: 1, UnitAmount: -600.03, AccountCode: "200", TaxType: "OUTPUT" },
    ]);
  });

  it("leaves Url out when the app's address isn't configured", () => {
    expect(P.buildXeroBody({ invoiceNumber: "IV3345-2", contactId: "c", composed, settings, url: null }).Invoices[0]).not.toHaveProperty("Url");
    expect(P.jobUrl(null, "tower")).toBeNull();
    expect(P.jobUrl("https://buhlos.com", "job/with space")).toBe("https://buhlos.com/v2/jobs/job%2Fwith%20space");
  });

  it("turns cents into exact dollars for any amount", () => {
    for (const cents of [1, 5, 10, 99, 100, 1005, 12_000_50, 33_333_33, 999_999_99, -660_03]) {
      expect(Math.round(P.dollars(cents) * 100)).toBe(cents);
    }
  });
});

describe("request identity", () => {
  const body = { Invoices: [{ InvoiceNumber: "IV3345-2", LineItems: [{ UnitAmount: 100 }] }] };

  it("the same invoice + the same body always gives the same key; a changed body or invoice gives another", () => {
    const h = P.requestHash(body);
    expect(P.requestHash(JSON.parse(JSON.stringify(body)))).toBe(h);
    const key = P.idempotencyKey("inv-1", h);
    expect(P.idempotencyKey("inv-1", h)).toBe(key);
    expect(P.idempotencyKey("inv-2", h)).not.toBe(key);
    expect(P.idempotencyKey("inv-1", P.requestHash({ Invoices: [{ InvoiceNumber: "IV3345-2", LineItems: [{ UnitAmount: 101 }] }] }))).not.toBe(key);
  });

  it("the key fits Xero's 128-character limit and gives nothing away", () => {
    const key = P.idempotencyKey("inv-1", P.requestHash(body));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("parseXeroInvoice — Xero's answer into integer cents and plain dates", () => {
  it("reads numbers or numeric strings, ISO or /Date()/ dates", () => {
    const m = P.parseXeroInvoice({
      InvoiceID: "x1", InvoiceNumber: "IV3345-2", Type: "ACCREC", Status: "authorised", Contact: { ContactID: "c-built", Name: "Built" },
      SubTotal: "11400.47", TotalTax: 1140.05, Total: "12540.52", AmountDue: "6540.52", AmountPaid: 6000, AmountCredited: "0.00",
      DueDate: "/Date(1798675200000+0000)/", FullyPaidOnDate: undefined, UpdatedDateUTCString: "2026-11-30T03:04:05Z",
      LineItems: [{ LineAmount: "12000.50" }, { UnitAmount: -600.03, Quantity: 1 }],
    });
    expect(m).toMatchObject({
      xeroInvoiceId: "x1", invoiceNumber: "IV3345-2", type: "ACCREC", status: "AUTHORISED", contactId: "c-built",
      subtotalCents: 11_400_47, taxCents: 1_140_05, totalCents: 12_540_52, amountDueCents: 6_540_52, amountPaidCents: 6_000_00, amountCreditedCents: 0,
      dueDate: "2026-12-31", fullyPaidOn: null, updatedAt: "2026-11-30T03:04:05.000Z", lineCents: [12_000_50, -600_03],
    });
    expect(P.parseXeroInvoice({ DueDateString: "2026-12-30T00:00:00", DueDate: "/Date(0)/" }).dueDate).toBe("2026-12-30");
  });

  it("a summary answer has no lines — that is 'not told', not 'no lines'", () => {
    expect(P.parseXeroInvoice({ InvoiceID: "x", SubTotal: 1 }).lineCents).toBeNull();
    expect(P.parseXeroInvoice(null)).toBeNull();
    expect(P.parseXeroInvoice({ SubTotal: "abc" }).subtotalCents).toBeNull();
  });
});

describe("verifyAgainst", () => {
  const sent = { invoiceNumber: "IV3345-2", contactId: "c-built", netCents: 11_400_47, lineCents: [12_000_50, -600_03] };
  const got = (over: Record<string, unknown> = {}) => ({
    type: "ACCREC", status: "DRAFT", invoiceNumber: "IV3345-2", contactId: "c-built", subtotalCents: 11_400_47, lineCents: [-600_03, 12_000_50], ...over,
  });

  it("matches when Xero holds what was sent (line order doesn't matter)", () => {
    expect(P.verifyAgainst(got(), sent)).toEqual({ verified: true, mismatches: [] });
  });

  it("names each thing that differs", () => {
    expect(P.verifyAgainst(got({ contactId: "other" }), sent).mismatches).toEqual(["contact"]);
    expect(P.verifyAgainst(got({ subtotalCents: 11_400_46 }), sent).mismatches).toEqual(["subtotal"]);
    expect(P.verifyAgainst(got({ lineCents: [11_400_47] }), sent).mismatches).toEqual(["lines"]);
    expect(P.verifyAgainst(got({ type: "ACCPAY" }), sent).mismatches).toEqual(["type:ACCPAY"]);
    expect(P.verifyAgainst(got({ invoiceNumber: "IV3345-3" }), sent).mismatches).toEqual(["invoice_number"]);
    expect(P.verifyAgainst(null, sent)).toEqual({ verified: false, mismatches: ["readback_empty"] });
  });

  it("straight after a create it MUST be a draft; when adopting later, an approved invoice is not a mismatch", () => {
    expect(P.verifyAgainst(got({ status: "AUTHORISED" }), sent).mismatches).toEqual(["status:AUTHORISED"]);
    expect(P.verifyAgainst(got({ status: "AUTHORISED" }), sent, { requireDraft: false }).verified).toBe(true);
    expect(P.verifyAgainst(got({ status: "WEIRD" }), sent, { requireDraft: false }).mismatches).toEqual(["status:WEIRD"]);
  });

  it("without line items (a summary) the subtotal still has to match", () => {
    expect(P.verifyAgainst(got({ lineCents: null }), sent).verified).toBe(true);
    expect(P.verifyAgainst(got({ lineCents: null, subtotalCents: 1 }), sent).verified).toBe(false);
  });
});

describe("small helpers", () => {
  it("recognises Xero saying the number is already used", () => {
    expect(P.isNumberTaken("Invoice # must be unique.")).toBe(true);
    expect(P.isNumberTaken("An invoice with that number already exists")).toBe(true);
    expect(P.isNumberTaken("Account code '999' is not a valid code for this document.")).toBe(false);
    expect(P.isNumberTaken(null)).toBe(false);
  });

  it("numbers an invoice job-code-dash-stage and adds days by the calendar", () => {
    expect(P.invoiceNumberFor("IV3345", 2)).toBe("IV3345-2");
    expect(P.addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(P.addDays("not-a-date", 1)).toBeNull();
    expect(P.addDays("2026-12-31", 1.5)).toBeNull();
  });
});
