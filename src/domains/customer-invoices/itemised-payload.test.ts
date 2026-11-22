import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Itemised invoices on the server (#1161) and payment-claim wording (#1164):
 * api/_lib/customer-invoices/amounts.js + payload.js. What an invoice's lines
 * add up to, exactly what Xero receives for them, and what never leaves
 * BuhlOS.
 */
const requireFromHere = createRequire(import.meta.url);
const A = requireFromHere("../../../api/_lib/customer-invoices/amounts.js");
const P = requireFromHere("../../../api/_lib/customer-invoices/payload.js");

const job = { id: "shop", name: "Corner Shop Rewire", code: "IV7001", siteAddress: "4 High St, Norwood" };
const settings = { salesAccountCode: "200", taxType: "OUTPUT", taxRateBp: 1000, paymentTermsDays: 14 };
const profile = { retentionBp: 0, xeroContactId: "c1" };

const ITEMS = [
  { id: "n1", type: "note", description: "Rewired the shop front." },
  { id: "a", type: "line", description: "Call-out fee", quantityMilli: 1000, unit: "ea", unitCents: 9500, source: "manual", costCents: null, refs: [] },
  { id: "b", type: "line", description: "Labour: Sam Sparky", quantityMilli: 14350, unit: "hr", unitCents: 9500, source: "labour", costCents: 68880, refs: [{ t: "h", u: "u_field", d: "2026-11-10", m: 14350 }] },
  { id: "c", type: "line", description: "Double GPO 10A white", quantityMilli: 6000, unit: "ea", unitCents: 1550, source: "material", costCents: 7440, refs: [{ t: "sl", id: "line-1" }] },
  { id: "d", type: "line", description: "Goodwill discount", quantityMilli: 1000, unit: null, unitCents: -5000, source: "manual", costCents: null, refs: [] },
];
const itemised = (over: Record<string, unknown> = {}) => ({
  kind: "itemised", title: "Shop front rewire", basis: "amount", amountCents: 150125, percentBp: null, extraLines: [],
  items: ITEMS, retentionBp: null, state: "planned", ...over,
});
const compose = (stage: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  P.composeInvoice({ stage, job, profile, settings, contractCents: null, invoiceDate: "2026-11-22", ...over });

describe("an itemised invoice's lines", () => {
  it("normalises stored lines and prices each one", () => {
    const items = A.itemsOf(itemised());
    expect(items.map((i: { type: string; amountCents?: number }) => [i.type, i.amountCents])).toEqual([
      ["note", undefined], ["line", 9500], ["line", 136325], ["line", 9300], ["line", -5000],
    ]);
  });

  it("drops anything that isn't a usable line rather than guessing at it", () => {
    const items = A.itemsOf({
      items: [
        { type: "line", description: "No quantity", unitCents: 100 },
        { type: "line", description: "  ", quantityMilli: 1000, unitCents: 100 },
        { type: "line", description: "Zero quantity", quantityMilli: 0, unitCents: 100 },
        { type: "line", description: "Fractional cents", quantityMilli: 1000, unitCents: 10.5 },
        null,
        "words",
        { type: "line", description: "Good", quantityMilli: 1000, unitCents: 100, source: "nonsense", costCents: "5", refs: "x" },
      ],
    });
    expect(items).toEqual([{ id: "", type: "line", description: "Good", quantityMilli: 1000, unit: null, unitCents: 100, amountCents: 100, source: "manual", costCents: null, refs: [] }]);
  });

  it("adds up to the charges; the stored amount is never trusted over the lines", () => {
    expect(A.computeStage(itemised({ amountCents: 1 }), { contractCents: null, retentionBp: 0 })).toMatchObject({
      baseCents: 150125, grossCents: 150125, retentionCents: 0, netCents: 150125, reason: null,
    });
  });

  it("takes the job's retention like any other invoice", () => {
    expect(A.computeStage(itemised(), { contractCents: null, retentionBp: 500 })).toMatchObject({
      grossCents: 150125, retentionCents: 7506, netCents: 142619,
    });
  });

  it("has no amount at all while it has no charge — never $0", () => {
    const c = A.computeStage(itemised({ items: [{ id: "n", type: "note", description: "Words" }] }), { contractCents: null, retentionBp: 0 });
    expect(c).toMatchObject({ grossCents: null, netCents: null, reason: "no_lines" });
    expect(P.blockersFor({ stage: itemised({ items: [] }), job, profile, settings, ready: { state: "connected", externalTenantId: null }, settingsComplete: true }).map((b: { code: string }) => b.code)).toContain("no_lines");
  });

  it("can't be sent when its lines cancel out", () => {
    const stage = itemised({ items: [ITEMS[1], { ...ITEMS[4], unitCents: -9500 }] });
    expect(P.blockersFor({ stage, job, profile, settings, ready: { state: "connected", externalTenantId: null }, settingsComplete: true }).map((b: { code: string }) => b.code)).toContain("nothing_to_invoice");
  });

  it("what it cost: only the lines that have a cost, and never when one is missing", () => {
    expect(A.itemsSummary(itemised())).toMatchObject({ lineCount: 4, totalCents: 150125, costCents: 76320, costedSellCents: 145625, costKnown: true });
    const noRate = itemised({ items: [{ ...ITEMS[2], costCents: null }] });
    expect(A.itemsSummary(noRate).costKnown).toBe(false);
    expect(A.itemsSummary({ items: [] })).toMatchObject({ lineCount: 0, costKnown: false });
  });
});

describe("what Xero receives for an itemised invoice", () => {
  const composed = compose(itemised());
  const body = P.buildXeroBody({ invoiceNumber: "IV7001-1", contactId: "c1", composed, settings });
  const lines = body.Invoices[0].LineItems;

  it("heads the invoice with the work and the job, as wording only", () => {
    expect(lines[0]).toEqual({ Description: "Shop front rewire\nCorner Shop Rewire, 4 High St, Norwood" });
    expect(lines[1]).toEqual({ Description: "Rewired the shop front." });
  });

  it("sends each charge with its quantity and unit price, not a total", () => {
    expect(lines.slice(2)).toEqual([
      { Description: "Call-out fee", Quantity: 1, UnitAmount: 95, AccountCode: "200", TaxType: "OUTPUT" },
      { Description: "Labour: Sam Sparky", Quantity: 14.35, UnitAmount: 95, AccountCode: "200", TaxType: "OUTPUT" },
      { Description: "Double GPO 10A white", Quantity: 6, UnitAmount: 15.5, AccountCode: "200", TaxType: "OUTPUT" },
      { Description: "Goodwill discount", Quantity: 1, UnitAmount: -50, AccountCode: "200", TaxType: "OUTPUT" },
    ]);
  });

  it("never sends cost, markup, where a line came from, or what it bills", () => {
    const sent = JSON.stringify(body);
    for (const secret of ["costCents", "68880", "7440", "refs", "u_field", "line-1", "source", "labour\"", "material"]) {
      expect(sent).not.toContain(secret);
    }
    expect(Object.keys(lines[3]).sort()).toEqual(["AccountCode", "Description", "Quantity", "TaxType", "UnitAmount"]);
  });

  it("is still a draft, create-only, ex GST", () => {
    expect(body.Invoices[0]).toMatchObject({ Type: "ACCREC", Status: "DRAFT", LineAmountTypes: "Exclusive", InvoiceNumber: "IV7001-1", Contact: { ContactID: "c1" } });
  });

  it("estimates GST the way Xero works it out: per line, rounded, then added up", () => {
    // 9.50 + 136.33 (136.325 rounds up) + 9.30 − 5.00
    expect(composed.estimatedTaxCents).toBe(15013);
    expect(composed.netCents).toBe(150125);
    // Three lines of $1.15: 11.5c GST each rounds to 12c, so 36c — where one
    // figure on the $3.45 subtotal would have said 35c.
    expect(P.estimateTaxCents([{ amountCents: 115 }, { amountCents: 115 }, { amountCents: 115 }], 1000)).toBe(36);
    expect(Math.round(345 * 0.1)).toBe(35);
    expect(P.estimateTaxCents([{ amountCents: -115 }], 1000)).toBe(-12);
    expect(P.estimateTaxCents([{ amountCents: 0, note: true }, { amountCents: 1000 }], 1000)).toBe(100);
    expect(P.estimateTaxCents([{ amountCents: 1000 }], null)).toBeNull();
  });

  it("puts retention last, as a negative line", () => {
    const withRet = compose(itemised(), { profile: { retentionBp: 500, xeroContactId: "c1" } });
    const last = withRet.lines[withRet.lines.length - 1];
    expect(last).toEqual({ description: "Less retention (5%)", amountCents: -7506 });
    expect(withRet.netCents).toBe(142619);
  });
});

describe("comparing what came back from Xero", () => {
  const composed = compose(itemised());
  const sent = { invoiceNumber: "IV7001-1", contactId: "c1", netCents: composed.netCents, lineCents: composed.lines.map((l: { amountCents: number }) => l.amountCents) };
  const xero = (lineItems: unknown[], subtotal = 1501.25) =>
    P.parseXeroInvoice({ InvoiceID: "x", InvoiceNumber: "IV7001-1", Type: "ACCREC", Status: "DRAFT", Contact: { ContactID: "c1" }, SubTotal: subtotal, TotalTax: 150.13, Total: 1651.38, LineItems: lineItems });

  it("matches when the charges match — wording lines carry no amount on either side", () => {
    const got = xero([
      { Description: "Shop front rewire" }, // no amount at all
      { Description: "Rewired the shop front.", LineAmount: 0 }, // or a zero
      { Quantity: 1, UnitAmount: 95, LineAmount: 95 },
      { Quantity: 14.35, UnitAmount: 95, LineAmount: 1363.25 },
      { Quantity: 6, UnitAmount: 15.5, LineAmount: 93 },
      { Quantity: 1, UnitAmount: -50, LineAmount: -50 },
    ]);
    expect(P.verifyAgainst(got, sent)).toEqual({ verified: true, mismatches: [] });
  });

  it("names a line Xero stored differently — a half cent rounded the other way is seen, not assumed away", () => {
    const got = xero([
      { Quantity: 1, UnitAmount: 95, LineAmount: 95 },
      { Quantity: 14.35, UnitAmount: 95, LineAmount: 1363.24 },
      { Quantity: 6, UnitAmount: 15.5, LineAmount: 93 },
      { Quantity: 1, UnitAmount: -50, LineAmount: -50 },
    ], 1501.24);
    expect(P.verifyAgainst(got, sent).mismatches).toEqual(["subtotal", "lines"]);
  });
});

describe("a retry sends exactly what was first sent", () => {
  it("rebuilds the same lines from the frozen row, wording included", () => {
    const stage = itemised();
    const first = compose(stage, { claim: { totals: { revisedContractCents: null, claimedCents: 0, variationsApprovedCents: 0 } } });
    const frozen = { ...stage, state: "failed", grossCents: first.grossCents, retentionBp: 0, retentionCents: 0, netCents: first.netCents, invoiceDate: "2026-11-22", dueDate: first.dueDate, reference: first.reference, sentFooter: first.footer };
    const again = P.composeFromSnapshot(frozen, job);
    expect(again.lines).toEqual(first.lines);
    const body = (c: unknown) => P.requestHash(P.buildXeroBody({ invoiceNumber: "IV7001-1", contactId: "c1", composed: c, settings }));
    expect(body(again)).toBe(body(first));
  });
});

describe("payment-claim wording (#1164)", () => {
  const stage = { kind: "stage", title: "Rough-in", basis: "percent", percentBp: 3000, amountCents: null, extraLines: [{ description: "Variation V1 — extra GPOs", amountCents: 110000, variationId: "v1" }], retentionBp: null, state: "planned" };
  const totals = { revisedContractCents: 9155000, claimedCents: 0, variationsApprovedCents: 155000 };

  it("is not there unless the job has it switched on", () => {
    const c = P.composeInvoice({ stage, job, profile, settings, contractCents: 9000000, invoiceDate: "2026-11-22" });
    expect(c.footer).toBeNull();
    expect(c.lines.some((l: { note?: boolean }) => l.note)).toBe(false);
  });

  it("adds the statement the SA Act asks for, and where the claim stands, as wording only", () => {
    const c = P.composeInvoice({ stage, job, profile, settings, contractCents: 9000000, invoiceDate: "2026-11-22", claim: { totals } });
    const last = c.lines[c.lines.length - 1];
    expect(last.note).toBe(true);
    expect(last.amountCents).toBe(0);
    expect(last.description).toBe(
      "This is a payment claim made under the Building and Construction Industry Security of Payment Act 2009 (SA).\n" +
      "Contract sum including approved variations: $91,550.00. Claimed to date including this claim: $28,100.00. Remaining: $63,450.00. All ex GST, before retention."
    );
    const xeroLine = P.buildXeroBody({ invoiceNumber: "IV3350-1", contactId: "c1", composed: c, settings }).Invoices[0].LineItems.slice(-1)[0];
    expect(xeroLine).toEqual({ Description: last.description });
    // wording changes neither the amount nor the GST
    expect(c.netCents).toBe(2810000);
    expect(c.estimatedTaxCents).toBe(281000);
  });

  it("counts what has already been claimed, and says 'Contract sum' when there are no variations", () => {
    const c = P.claimFooter({ stage, grossCents: 2700000, totals: { revisedContractCents: 9000000, claimedCents: 1800000, variationsApprovedCents: 0 } });
    expect(c).toContain("Contract sum: $90,000.00. Claimed to date including this claim: $45,000.00. Remaining: $45,000.00.");
  });

  it("a retention release adds nothing to what has been claimed", () => {
    const c = P.claimFooter({ stage: { kind: "retention_release" }, grossCents: 500000, totals: { revisedContractCents: 9000000, claimedCents: 9000000, variationsApprovedCents: 0 } });
    expect(c).toContain("Claimed to date including this claim: $90,000.00. Remaining: $0.00.");
  });

  it("is the statement alone on a job with no contract value — no made-up figures", () => {
    expect(P.claimFooter({ stage, grossCents: 1000, totals: { revisedContractCents: null, claimedCents: 0, variationsApprovedCents: 0 } })).toBe(P.CLAIM_STATEMENT);
  });

  it("writes money the way an invoice does", () => {
    expect(P.moneyText(123456789)).toBe("$1,234,567.89");
    expect(P.moneyText(5)).toBe("$0.05");
    expect(P.moneyText(-150000)).toBe("-$1,500.00");
  });
});

describe("the job's totals with variations (#1163)", () => {
  const rows = [
    { kind: "stage", state: "sent", grossCents: 2810000, retentionCents: 0, xeroStatus: "DRAFT", xeroSubtotalCents: 2810000 },
    { kind: "stage", state: "planned", basis: "amount", amountCents: 1000000, extraLines: [] },
  ];
  const variations = [
    { status: "approved", approvedCents: 110000, quotedCents: 120000 },
    { status: "approved", approvedCents: 45000, quotedCents: 45000 },
    { status: "proposed", quotedCents: 30000 },
    { status: "proposed", quotedCents: null },
    { status: "declined", quotedCents: 99999999 },
  ];

  it("approved variations add to the contract; proposed and declined ones don't", () => {
    const t = A.jobTotals(rows, { contractCents: 9000000, retentionBp: 0, variations });
    expect(t).toMatchObject({
      contractCents: 9000000, revisedContractCents: 9155000,
      variationsApprovedCents: 155000, variationsApprovedCount: 2,
      variationsPendingCents: 30000, variationsPendingCount: 2, variationsUnpricedCount: 1,
      claimedCents: 2810000, stillToInvoiceCents: 9155000 - 2810000, overContract: false,
    });
  });

  it("'over the contract' is measured against the contract WITH its variations", () => {
    const big = [{ kind: "stage", state: "planned", basis: "amount", amountCents: 9100000, extraLines: [] }];
    expect(A.jobTotals(big, { contractCents: 9000000, retentionBp: 0, variations: [] }).overContract).toBe(true);
    expect(A.jobTotals(big, { contractCents: 9000000, retentionBp: 0, variations }).overContract).toBe(false);
  });

  it("a job with no contract value has no total to add variations to", () => {
    const t = A.jobTotals([], { contractCents: null, retentionBp: 0, variations });
    expect(t).toMatchObject({ revisedContractCents: null, stillToInvoiceCents: null, variationsApprovedCents: 155000, overContract: false });
  });

  it("without any variations nothing changes", () => {
    const t = A.jobTotals(rows, { contractCents: 9000000, retentionBp: 0 });
    expect(t).toMatchObject({ revisedContractCents: 9000000, variationsApprovedCents: 0, stillToInvoiceCents: 9000000 - 2810000 });
  });
});
