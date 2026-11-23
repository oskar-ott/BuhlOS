import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AddFromJob, type AddFromJobTab } from "./AddFromJob";
import { ItemisedEditor, sourceCaption } from "./ItemisedEditor";
import { JobGettingPaidBody } from "./JobGettingPaidCard";
import { MoneyInNote } from "./MoneyInNote";
import { VariationsSection, buildVariationInput, variationStanding } from "./VariationsSection";
import { blankLine, type ItemDraft } from "@/domains/customer-invoices/itemised";
import type {
  BillableResponse,
  InvoiceItem,
  JobInvoicingResponse,
  Stage,
  Variation,
} from "@/domains/customer-invoices/schema";
import type { JobProfitabilityResponse } from "@/domains/jobs/profitability-client";

/**
 * Part 2 on the job's Getting paid card: the itemised invoice editor and its
 * "Add from this job" panel (#1161 / #1162), the variations list (#1163) and
 * the payment-claim line (#1164). Every state is a pure function of its props,
 * so each is pinned here as the office would read it — above all that nothing
 * is shown as a figure unless it is one, and that cost and margin are marked
 * as the office's own.
 */
const noop = () => {};
const run = async () => true;
const render = (el: Parameters<typeof renderToString>[0]) => renderToString(el).replace(/<!-- -->/g, "");
/** The page as a person reads it: the words, with typographic apostrophes
 *  written plainly so an assertion can be typed on a keyboard. */
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;|\u2019/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const ITEMS: InvoiceItem[] = [
  { id: "n1", type: "note", description: "Rewired the shop front." },
  { id: "a", type: "line", description: "Call-out fee", quantityMilli: 1000, unit: "ea", unitCents: 9500, amountCents: 9500, source: "manual", costCents: null, refs: [] },
  { id: "b", type: "line", description: "Labour: Sam Sparky", quantityMilli: 14350, unit: "hr", unitCents: 9500, amountCents: 136325, source: "labour", costCents: 68880, refs: [{ t: "h", u: "u", d: "2026-11-10", m: 14350 }] },
  { id: "c", type: "line", description: "Double GPO 10A white", quantityMilli: 6000, unit: "ea", unitCents: 1550, amountCents: 9300, source: "material", costCents: 7440, refs: [{ t: "sl", id: "l1" }] },
];

function stage(over: Partial<Stage> = {}): Stage {
  return {
    id: "s1", jobId: "shop", kind: "itemised", seq: null, invoiceNumber: null, title: "Shop front rewire",
    basis: "amount", percentBp: null, amountCents: 155125, extraLines: [], retentionBp: null, plannedDate: null, note: null,
    state: "planned", version: 1,
    computed: { grossCents: 155125, retentionBp: 0, retentionCents: 0, netCents: 155125, reason: null },
    display: "planned",
    items: ITEMS,
    itemsSummary: { lineCount: 3, totalCents: 155125, costCents: 76320, costedSellCents: 145625, costKnown: true },
    ...over,
  };
}

function data(over: Partial<JobInvoicingResponse> = {}): JobInvoicingResponse {
  return {
    jobId: "shop",
    job: { name: "Corner Shop Rewire", code: "IV7001", clientName: null, contractCents: null },
    profile: { jobId: "shop", retentionBp: 0, xeroContactId: "c1", xeroContactName: "Built Pty Ltd", externalTenantId: "org-1", version: 1 },
    stages: [],
    variations: [],
    totals: {
      contractCents: null, plannedCount: 0, plannedGrossCents: 0, plannedNetCents: 0, unresolvedCount: 0, sentCount: 0,
      claimedCents: 0, stillToInvoiceCents: null, overContract: false, retentionHeldCents: 0,
      draftedCents: 0, invoicedCents: 0, paidCents: 0, paidIncGstCents: 0, dueIncGstCents: 0,
    },
    xero: { state: "connected", organisationName: "Buhl Electrical", settingsComplete: true, sendReady: true, client: { linked: true, name: "Built Pty Ltd", otherOrganisation: false, suggestion: null } },
    statusAsOf: null,
    asOf: "2026-11-22T00:00:00.000Z",
    ...over,
  };
}
const body = (d: JobInvoicingResponse) => render(createElement(JobGettingPaidBody, { data: d, onData: noop, onStale: noop }));

describe("the itemised invoice editor", () => {
  const editor = (s: Stage | null, jobRetentionBp = 0) =>
    render(createElement(ItemisedEditor, { jobId: "shop", jobRetentionBp, stage: s, onClose: noop, onSaved: noop, onStale: noop }));

  it("a new invoice: asks what the work was, one empty line, and no figure until there is one", () => {
    const html = editor(null);
    const t = text(html);
    expect(t).toContain("Add an itemised invoice");
    expect(t).toContain("What was the work?");
    expect(t).toContain("Prices are ex GST. Use a minus price for a discount.");
    expect(t).toContain("Add a line with a price to see what this invoice comes to.");
    for (const b of ["Add a line", "Add a note", "Add from this job", "Add invoice"]) expect(t).toContain(b);
    expect(html).toContain('aria-label="Line 1 description"');
    expect(html).toContain('aria-label="Line 1 quantity"');
    expect(html).toContain('aria-label="Line 1 unit price in dollars"');
    expect(html).not.toContain("$"); // no made-up $0.00
    expect(html).not.toContain("itemised-margin");
  });

  it("editing: every line comes back with its quantity, unit and price, and its total", () => {
    const html = editor(stage());
    const t = text(html);
    expect(t).toContain("Edit itemised invoice");
    expect(html).toContain('value="Shop front rewire"');
    expect(html).toContain("Rewired the shop front.");
    for (const v of ['value="14.35"', 'value="hr"', 'value="95.00"', 'value="15.50"', 'value="6"']) expect(html).toContain(v);
    expect(t).toContain("$1,363.25");
    expect(t).toContain("$93.00");
    expect(t).toContain("This invoice comes to $1,551.25 ex GST.");
    expect(t).toContain("Save changes");
  });

  it("says where a pulled line came from and what it cost — under the line, for the office", () => {
    const t = text(editor(stage()));
    expect(t).toContain("From 1 day of approved hours. Cost $688.80.");
    expect(t).toContain("From 1 supplier item. Cost $74.40. Markup 25%.");
  });

  it("shows cost and margin marked as the office's own, as a share of the sale", () => {
    const t = text(editor(stage()));
    // lines with a cost: $1,363.25 + $93.00 = $1,456.25; cost $763.20
    expect(t).toContain("Office only, never sent to Xero: the lines with a cost come to $1,456.25 and cost $763.20, a margin of $693.05 (47.59% of the sale).");
  });

  it("leaves the margin out — and says why — when a worker has no cost rate", () => {
    const items = ITEMS.map((i) => (i.id === "b" && i.type === "line" ? { ...i, costCents: null } : i));
    const t = text(editor(stage({ items })));
    expect(t).toContain("the margin isn't shown, because a worker on this invoice has no cost rate.");
    expect(t).toContain("Cost not known: a worker has no cost rate.");
    expect(t).not.toContain("a margin of");
  });

  it("shows retention coming off when the job holds any", () => {
    const t = text(editor(stage(), 500));
    expect(t).toContain("Less 5% retention ($77.56), $1,473.69 would be invoiced.");
  });

  it("a variation's line can't be repriced", () => {
    const items: InvoiceItem[] = [{ id: "v", type: "line", description: "Variation V1 — Extra GPOs", quantityMilli: 1000, unit: null, unitCents: 110000, amountCents: 110000, source: "variation", costCents: null, refs: [{ t: "v", id: "v1" }] }];
    const html = editor(stage({ items }));
    expect(text(html)).toContain("An approved variation, billed at the approved amount.");
    expect(html).toMatch(/aria-label="Line 1 unit price in dollars"[^>]*disabled=""/);
    expect(html).toMatch(/aria-label="Line 1 quantity"[^>]*disabled=""/);
  });

  it("captions: nothing for a typed line", () => {
    const typed: ItemDraft = { ...blankLine(), description: "Typed", price: "5" };
    expect(sourceCaption(typed, 500)).toBeNull();
    expect(sourceCaption({ ...typed, source: "material", refs: [{ t: "sl", id: "a" }, { t: "sl", id: "b" }], costCents: 400 }, 500)).toBe("From 2 supplier items. Cost $4.00. Markup 25%.");
    // a credit, or a zero cost, has no markup to state
    expect(sourceCaption({ ...typed, source: "material", refs: [{ t: "sl", id: "a" }], costCents: 0 }, 500)).toBe("From 1 supplier item. Cost $0.00.");
    expect(sourceCaption({ ...typed, source: "labour", refs: [{ t: "h", u: "u", d: "2026-11-10", m: 1000 }, { t: "h", u: "u", d: "2026-11-11", m: 1000 }], costCents: 9600 }, 19000)).toBe("From 2 days of approved hours. Cost $96.00.");
  });
});

// ── Add from this job ───────────────────────────────────────────────────────

const day = (userId: string, name: string, date: string, unbilledMilli: number, over: Record<string, unknown> = {}) => ({
  userId, name, date, hoursMilli: unbilledMilli, billedMilli: 0, unbilledMilli, onInvoice: null, chargeOutRateCents: 9500, costRateCents: 4800, hasCostRate: true, ...over,
});
function billable(over: Partial<BillableResponse> = {}): BillableResponse {
  return {
    jobId: "shop",
    labour: {
      available: true, reason: null, pendingMilli: 1500,
      days: [
        day("sam", "Sam Sparky", "2026-11-10", 4500),
        day("sam", "Sam Sparky", "2026-11-11", 7600),
        day("dy", "Dylan Sinclair", "2026-11-11", 3000, { chargeOutRateCents: null }),
        day("old", "Old Hand", "2026-11-01", 0, { hoursMilli: 8000, billedMilli: 8000, onInvoice: "IV7001-1" }),
      ],
    },
    supplier: {
      available: true, reason: null,
      lines: [
        { id: "l1", invoiceId: "i1", supplier: "Rexel Norwood", number: "RX-1", date: "2026-11-10", description: "2.5mm TPS twin & earth", quantity: 100, unit: "m", unitCostCents: 185, costCents: 18500, onInvoice: null },
        { id: "l2", invoiceId: "i1", supplier: "Rexel Norwood", number: "RX-1", date: "2026-11-10", description: "Double GPO 10A white", quantity: 6, unit: "ea", unitCostCents: 1240, costCents: 7440, onInvoice: "IV7001-1" },
      ],
      whole: [],
    },
    ledger: { available: true, reason: null, lines: [{ id: "ml_1", supplier: "Bunnings", number: "D-88", date: "2026-11-11", description: "Saddles", costCents: 3460, onInvoice: null }] },
    summary: { unbilledHoursMilli: 15100, unbilledMaterialCount: 2, unbilledMaterialCostCents: 21960, anyBilled: true },
    prefs: { materialsMarkupBp: 2500, labourRoundMinutes: 0, usualCharges: [{ id: "c1", name: "Call-out fee", unit: "ea", unitCents: 9500, kind: "other" }, { id: "c2", name: "Tradesman", unit: "hr", unitCents: 11000, kind: "labour" }], version: 1 },
    asOf: "2026-11-22T00:00:00.000Z",
    ...over,
  };
}
const panel = (tab: AddFromJobTab, b: BillableResponse | null, over: Record<string, unknown> = {}) =>
  render(createElement(AddFromJob, {
    tab, onTab: noop, state: "idle", billable: b, usedKeys: new Set<string>(), room: 90, onAdd: noop, onPrefs: noop, onClose: noop, onRetry: noop, ...over,
  }));

describe("Add from this job — hours", () => {
  it("lists each worker's hours that aren't on an invoice, with the price that will be charged", () => {
    const html = panel("hours", billable());
    const t = text(html);
    expect(t).toContain("Sam Sparky · 12.1 h · 2 days, 10 Nov 2026 to 11 Nov 2026");
    expect(t).toContain("Dylan Sinclair · 3 h · 1 day, 11 Nov 2026");
    expect(t).not.toContain("Old Hand"); // all of it is already on an invoice
    expect(html).toMatch(/aria-label="Hourly price for Sam Sparky"[^>]*value="95.00"/);
    expect(t).toContain("15.1 h logged, as 2 lines.");
    expect(t).toContain("Add these 2 lines");
  });

  it("never invents a rate: a worker with no charge-out rate has a blank price, and it says so", () => {
    const html = panel("hours", billable());
    expect(html).toMatch(/aria-label="Hourly price for Dylan Sinclair"[^>]*value=""/);
    expect(text(html)).toContain("A worker with no charge-out rate has no price here. Type one, or leave it blank and fill the price in on the line.");
  });

  it("offers the business's own hourly rates, and says what can't be invoiced yet", () => {
    const t = text(panel("hours", billable()));
    expect(t).toContain("Price everyone at: Tradesman ($110.00)");
    expect(t).not.toContain("Call-out fee ($95.00)"); // not an hourly rate
    expect(t).toContain("Another 1.5 h on this job is logged but not approved yet, so it can't be invoiced until it is.");
  });

  it("leaves out hours the draft itself already has", () => {
    const t = text(panel("hours", billable(), { usedKeys: new Set(["h:sam|2026-11-10", "h:sam|2026-11-11"]) }));
    expect(t).not.toContain("Sam Sparky");
    expect(t).toContain("Dylan Sinclair");
  });

  it("says when there is nothing left, and when the time sheets couldn't be read", () => {
    const none = billable();
    none.labour = { ...none.labour, pendingMilli: 0, days: none.labour.days.filter((d) => d.userId === "old") };
    expect(text(panel("hours", none))).toContain("No approved hours on this job are waiting to be invoiced. The hours logged are already on an invoice.");
    const down = billable();
    down.labour = { available: false, reason: "unreadable", days: [], pendingMilli: 0 };
    expect(text(panel("hours", down))).toContain("The time sheets couldn't be read just now, so hours can't be pulled in. Type the labour line instead, or try again shortly.");
  });
});

describe("Add from this job — materials", () => {
  it("lists what isn't on an invoice with its cost, priced at the usual markup", () => {
    const html = panel("materials", billable());
    const t = text(html);
    expect(t).toContain("2 items not on an invoice yet · 1 already on one");
    expect(t).toContain("2.5mm TPS twin & earth");
    expect(t).toContain("Rexel Norwood RX-1 · 10 Nov 2026 · 100 m");
    expect(t).toContain("Saddles");
    expect(t).not.toContain("Double GPO 10A white"); // on IV7001-1 already
    expect(html).toMatch(/data-testid="add-materials-markup"[^>]*value="25"|value="25"[^>]*data-testid="add-materials-markup"/);
    // 185.00 + 34.60 = 219.60, plus 25% = 274.50
    expect(t).toContain("Cost $219.60 plus 25% is $274.50 ex GST. The client sees the price, never the cost or the markup.");
    expect(t).toContain("Add these 2 lines");
  });

  it("asks for a markup rather than assuming one when the business hasn't set its usual", () => {
    const b = billable();
    b.prefs = { ...b.prefs, materialsMarkupBp: null };
    const html = panel("materials", b);
    expect(text(html)).toContain("Cost $219.60. Enter a markup to price it — 0 for at cost.");
    expect(html).toMatch(/data-testid="add-materials-go"[^>]*disabled=""|disabled=""[^>]*data-testid="add-materials-go"/);
  });

  it("says plainly when materials aren't recorded, and when they couldn't be read", () => {
    const off = billable();
    off.supplier = { available: false, reason: "off", lines: [], whole: [] };
    off.ledger = { available: false, reason: "off", lines: [] };
    expect(text(panel("materials", off))).toContain("Materials aren't being recorded against jobs yet, so there is nothing to pull in. Type the lines instead.");
    const down = billable();
    down.supplier = { available: false, reason: "unreadable", lines: [], whole: [] };
    down.ledger = { available: false, reason: "off", lines: [] };
    expect(text(panel("materials", down))).toContain("This job's materials couldn't be read just now. Type the lines instead, or try again shortly.");
    const half = billable();
    half.supplier = { available: false, reason: "unreadable", lines: [], whole: [] };
    expect(text(panel("materials", half))).toContain("Some of this job's materials couldn't be read just now, so this list may be short.");
  });
});

describe("Add from this job — usual charges", () => {
  it("lists the business's own charges, one tap each, and its usual markup", () => {
    const t = text(panel("usual", billable()));
    expect(t).toContain("Call-out fee · $95.00 per ea");
    expect(t).toContain("Tradesman · $110.00 per hr");
    expect(t).toContain("Usual markup on materials: 25%.");
    expect(t).toContain("Change the usual charges and markup");
  });

  it("starts empty — BuhlOS ships no charges and no markup", () => {
    const b = billable();
    b.prefs = { materialsMarkupBp: null, labourRoundMinutes: 0, usualCharges: [], version: null };
    const t = text(panel("usual", b));
    expect(t).toContain("No usual charges yet.");
    expect(t).toContain("Usual markup on materials: not set.");
    expect(t).not.toContain("$");
  });
});

describe("Add from this job — while it loads, and when it can't", () => {
  it("says it is reading, then says it couldn't — and that the lines can still be typed", () => {
    expect(text(panel("hours", null, { state: "loading" }))).toContain("Reading this job's hours and materials…");
    const t = text(panel("hours", null, { state: "error" }));
    expect(t).toContain("Couldn't read this job's hours and materials just now. You can still type the lines.");
    expect(t).toContain("Try again");
  });
});

// ── the card ────────────────────────────────────────────────────────────────

describe("an itemised invoice on the Getting paid card", () => {
  it("shows its lines the way they will be invoiced, and offers both kinds of invoice", () => {
    const html = body(data({ stages: [stage()], totals: { ...data().totals, plannedCount: 1, plannedGrossCents: 155125, plannedNetCents: 155125 } }));
    const t = text(html);
    expect(t).toContain("Shop front rewire");
    expect(t).toContain("itemised · 3 lines");
    expect(t).toContain("Labour: Sam Sparky · 14.35 hr × $95.00 = $1,363.25");
    expect(t).toContain("Double GPO 10A white · 6 ea × $15.50 = $93.00");
    expect(t).toContain("Rewired the shop front.");
    expect(t).toContain("Office only: cost $763.20, margin $693.05 on the lines with a cost.");
    expect(t).toContain("1 invoice not sent yet");
    expect(t).toContain("Add itemised invoice");
    expect(t).toContain("Add stage");
    expect(t).toContain("Send to Xero");
  });

  it("a small job with no contract isn't nagged to set one", () => {
    const t = text(body(data({ stages: [stage()] })));
    expect(t).toContain("this job has no contract value");
    expect(t).not.toContain("set the contract value on the Money card");
    // …but a job with nothing on it still is
    expect(text(body(data()))).toContain("set the contract value on the Money card");
  });

  it("shows only the first few lines of a long invoice", () => {
    const many: InvoiceItem[] = Array.from({ length: 9 }, (_, i) => ({ id: `x${i}`, type: "line", description: `Item ${i + 1}`, quantityMilli: 1000, unit: null, unitCents: 100, amountCents: 100, source: "manual", costCents: null, refs: [] }));
    const t = text(body(data({ stages: [stage({ items: many, itemsSummary: undefined })] })));
    expect(t).toContain("Item 6");
    expect(t).not.toContain("Item 7");
    expect(t).toContain("and 3 more");
    expect(t).not.toContain("Office only");
  });

  it("once sent, the margin line is gone and Xero's figures are shown", () => {
    const sent = stage({ state: "sent", display: "draft_in_xero", invoiceNumber: "IV7001-1", seq: 1, xeroInvoiceId: "x1", xeroStatus: "DRAFT", xeroSubtotalCents: 155125, xeroTaxCents: 15513, xeroTotalCents: 170638 });
    const t = text(body(data({ stages: [sent], totals: { ...data().totals, sentCount: 1, claimedCents: 155125, draftedCents: 155125 } })));
    expect(t).toContain("IV7001-1");
    expect(t).toContain("+ $155.13 GST = $1,706.38 · Xero's figures");
    expect(t).not.toContain("Office only");
    expect(t).not.toContain("Send to Xero");
  });

  it("an empty job is told about both kinds", () => {
    expect(text(body(data()))).toContain("For a small job, add an itemised invoice.");
  });
});

// ── variations ──────────────────────────────────────────────────────────────

function variation(over: Partial<Variation> = {}): Variation {
  return {
    id: "v1", jobId: "tower", seq: 1, number: "V1", title: "Four extra power points", detail: null, requestedBy: "Site manager", requestedOn: "2026-11-18",
    quotedCents: 120000, status: "proposed", approvedCents: null, approvalRef: null, decidedOn: null, billedOn: null, version: 1, ...over,
  };
}
const towerData = (variations: Variation[], over: Partial<JobInvoicingResponse> = {}) =>
  data({
    jobId: "tower",
    job: { name: "Tower Fit-out", code: "IV3345", clientName: "Built Pty Ltd", contractCents: 9000000 },
    variations,
    totals: { ...data().totals, contractCents: 9000000, revisedContractCents: 9000000, stillToInvoiceCents: 9000000 },
    ...over,
  });
const section = (d: JobInvoicingResponse) => text(render(createElement(VariationsSection, { data: d, run })));

describe("the variations list", () => {
  it("is empty with a reason to use it", () => {
    const t = section(towerData([]));
    expect(t).toContain("None on this job. Record a variation when it is asked for, before the work is done");
    expect(t).toContain("Add variation");
  });

  it("a proposed one: who asked, the price, and the two answers it can get", () => {
    const t = section(towerData([variation()]));
    expect(t).toContain("V1 Four extra power points Waiting on approval");
    expect(t).toContain("Asked for by Site manager on 18 Nov 2026");
    expect(t).toContain("$1,200.00");
    for (const b of ["Approved", "Declined", "Edit", "Remove"]) expect(t).toContain(b);
    expect(t).not.toContain("Put on an invoice");
  });

  it("one that isn't priced says so, with a dash for the amount — never $0", () => {
    const t = section(towerData([variation({ quotedCents: null })]));
    expect(t).toContain("Not priced");
    expect(t).not.toContain("$");
  });

  it("an approved one that isn't billed says so, shows how it was approved, and can go on an invoice", () => {
    const t = section(towerData([variation({ status: "approved", approvedCents: 110000, approvalRef: "Email from site manager", decidedOn: "2026-11-20", version: 2 })]));
    expect(t).toContain("Approved, not billed");
    expect(t).toContain("Approved 20 Nov 2026: Email from site manager");
    expect(t).toContain("$1,100.00");
    expect(t).toContain("quoted $1,200.00");
    expect(t).toContain("Put on an invoice");
    expect(t).toContain("Back to proposed");
    expect(t).not.toContain("Edit");
  });

  it("a billed one names its invoice and offers nothing — it is settled", () => {
    const t = section(towerData([variation({ status: "approved", approvedCents: 110000, billedOn: "IV3345-2" })]));
    expect(t).toContain("On IV3345-2");
    for (const b of ["Put on an invoice", "Back to proposed", "Remove", "Edit"]) expect(t).not.toContain(b);
  });

  it("a declined one is struck through and adds nothing", () => {
    const html = render(createElement(VariationsSection, { data: towerData([variation({ status: "declined", decidedOn: "2026-11-21" })]), run }));
    expect(text(html)).toContain("Declined");
    expect(html).toContain("line-through");
    expect(text(html)).toContain("Back to proposed");
  });

  it("standing, in one phrase each", () => {
    expect(variationStanding(variation())).toEqual({ label: "Waiting on approval", tone: "warning" });
    expect(variationStanding(variation({ quotedCents: null }))).toEqual({ label: "Not priced", tone: "warning" });
    expect(variationStanding(variation({ status: "approved", approvedCents: 1 }))).toEqual({ label: "Approved, not billed", tone: "warning" });
    expect(variationStanding(variation({ status: "approved", approvedCents: 1, billedOn: "Rough-in" }))).toEqual({ label: "On Rough-in", tone: "success" });
    expect(variationStanding(variation({ status: "declined" }))).toEqual({ label: "Declined", tone: "neutral" });
  });

  it("the form: a name is needed, a price is not", () => {
    const blank = { title: "", detail: "", requestedBy: "", requestedOn: "", price: "" };
    expect(buildVariationInput(blank)).toEqual({ ok: false, message: "Say what the variation is." });
    expect(buildVariationInput({ ...blank, title: " Extra GPOs " })).toEqual({ ok: true, input: { title: "Extra GPOs", detail: null, requestedBy: null, requestedOn: null, quotedCents: null } });
    expect(buildVariationInput({ ...blank, title: "x", price: "1,200.50", requestedBy: " Sam ", requestedOn: "2026-11-18", detail: " more " })).toEqual({
      ok: true, input: { title: "x", detail: "more", requestedBy: "Sam", requestedOn: "2026-11-18", quotedCents: 120050 },
    });
    expect(buildVariationInput({ ...blank, title: "x", price: "lots" })).toMatchObject({ ok: false });
    expect(buildVariationInput({ ...blank, title: "x", requestedOn: "soon" })).toEqual({ ok: false, message: "Pick a valid date." });
  });
});

describe("variations on the card's figures", () => {
  it("approved variations are added to the contract, and 'still to invoice' follows", () => {
    const d = towerData([variation({ status: "approved", approvedCents: 110000 })], {
      totals: { ...data().totals, contractCents: 9000000, revisedContractCents: 9110000, variationsApprovedCents: 110000, stillToInvoiceCents: 9110000 },
    });
    const t = text(body(d));
    expect(t).toContain("Contract + variations");
    expect(t).toContain("$91,100.00");
    expect(t).toContain("$90,000.00 + $1,100.00 approved variations");
    expect(t).toContain("$91,100.00 not yet planned");
  });

  it("with none approved the card reads as it always did", () => {
    const t = text(body(towerData([variation()])));
    expect(t).not.toContain("Contract + variations");
    expect(t).toContain("$90,000.00 not yet planned");
  });
});

describe("payment-claim wording on the card", () => {
  it("is off unless the job has it on, and says what it does when it is", () => {
    expect(text(body(towerData([])))).toContain("Payment-claim wording: off.");
    const on = towerData([], { profile: { ...data().profile, paymentClaim: true } });
    expect(text(body(on))).toContain("Payment-claim wording: on. Invoices sent for this job say they are a claim under the SA Security of Payment Act.");
  });
});

// ── the Money card ──────────────────────────────────────────────────────────

const moneyIn = (over: Partial<NonNullable<JobProfitabilityResponse["customerInvoices"]>> = {}): NonNullable<JobProfitabilityResponse["customerInvoices"]> => ({
  unavailable: false, sentCount: 1, plannedCount: 0, draftedCents: 226700, invoicedCents: 0, paidCents: 0, paidIncGstCents: 0, dueIncGstCents: 0,
  stillToInvoiceCents: null, retentionHeldCents: 0, overdueCount: 0, cashCents: -135180, asOf: "2026-11-22T00:00:00.000Z",
  variationsApprovedCents: 0, revisedContractCents: null, billedCents: 226700, billedMarginCents: 91520,
  ...over,
});
const note = (m: JobProfitabilityResponse["customerInvoices"], props: Record<string, unknown> = {}) =>
  text(render(createElement(MoneyInNote, { moneyIn: m, labourUnderstated: false, ...props })));

describe("Money card — a small job's margin, and variations", () => {
  it("a job with no contract value: its margin is what has been sent to Xero less its costs", () => {
    const t = note(moneyIn(), { hasContract: false });
    expect(t).toContain("On the $2,267.00 sent to Xero so far: $915.20 left after labour and materials to date. This job has no contract value, so that is its margin so far.");
  });

  it("says so when labour is understated, and shows a loss as one", () => {
    expect(note(moneyIn(), { hasContract: false, labourUnderstated: true })).toContain("to date, before uncosted labour.");
    expect(note(moneyIn({ billedMarginCents: -5000 }), { hasContract: false })).toContain("-$50.00 left after labour and materials");
  });

  it("is not shown on a job that has a contract value, nor before anything is sent", () => {
    expect(note(moneyIn(), { hasContract: true })).not.toContain("sent to Xero so far");
    expect(note(moneyIn({ sentCount: 0, billedMarginCents: null }), { hasContract: false })).not.toContain("sent to Xero so far");
  });

  it("approved variations: what they add, and that the margin above is on the contract alone", () => {
    const t = note(moneyIn({ variationsApprovedCents: 110000, revisedContractCents: 9110000 }));
    expect(t).toContain("Approved variations add $1,100.00: with them the job is worth $91,100.00 ex GST. The margin above is on the contract alone.");
    expect(note(moneyIn())).not.toContain("Approved variations");
  });
});
