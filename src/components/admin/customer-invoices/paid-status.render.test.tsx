import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { JobGettingPaidBody } from "./JobGettingPaidCard";
import { MoneyInNote } from "./MoneyInNote";
import { StageRow, type StageRowActions } from "./StageRow";
import { STATUS_LABEL, STATUS_TONE, agoLabel, refreshMessage } from "@/domains/customer-invoices/format";
import type { JobInvoicingResponse, Stage } from "@/domains/customer-invoices/schema";
import type { JobProfitabilityResponse } from "@/domains/jobs/profitability-client";
import { QUIET_UNTIL_USED, XERO_SYNC_TYPES } from "@/domains/xero/sync-log";

/**
 * What the office sees after a send (#1151): every state an invoice can be in
 * once Xero has it, the job's money-in strip, and the money-in line on the
 * Money card. The rule under test everywhere: the figures are XERO'S, said to
 * be Xero's, and a dead or unread invoice is never shown as money.
 */
const noop = () => {};
const render = (el: ReactElement) => renderToString(el).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");
const actions: StageRowActions = {
  onEdit: noop, onAskRemove: noop, onCancelRemove: noop, onRemove: noop, onSend: noop, onCheck: noop, onReset: noop, onRaiseAgain: noop,
};

function sent(over: Partial<Stage> = {}): Stage {
  return {
    id: "s1", jobId: "tower", kind: "stage", seq: 1, invoiceNumber: "IV3345-1", title: "Deposit", basis: "percent", percentBp: 2000,
    amountCents: null, extraLines: [], retentionBp: null, plannedDate: null, note: null, state: "sent", version: 3,
    invoiceDate: "2026-11-22", dueDate: "2026-12-22",
    xeroInvoiceId: "aaaaaaaa-0000-4000-8000-000000000001", xeroStatus: "AUTHORISED",
    xeroSubtotalCents: 50_000_00, xeroTaxCents: 5_000_00, xeroTotalCents: 55_000_00,
    xeroAmountPaidCents: 0, xeroAmountDueCents: 55_000_00, xeroDueDate: "2026-12-22", xeroFullyPaidOn: null,
    lastCheckedAt: "2026-12-01T00:00:00.000Z", canRaiseAgain: false, replacedById: null,
    computed: { grossCents: 50_000_00, retentionBp: 0, retentionCents: 0, netCents: 50_000_00, reason: null },
    display: "awaiting_payment",
    ...over,
  };
}
const rowHtml = (s: Stage, busy = false) =>
  render(createElement(StageRow, { stage: s, busy, confirmingRemove: false, sendReady: true, actions }));

describe("StageRow — after Xero has it", () => {
  it("approved: awaiting payment, with what is owing (Xero's GST-inclusive figure)", () => {
    const html = rowHtml(sent());
    expect(html).toContain("Awaiting payment");
    expect(html).toContain("$55,000.00 owing (inc GST)");
    expect(html).not.toContain("$0.00 paid");
    expect(html).toContain("due 22 Dec 2026");
    expect(html).not.toContain("Raise again");
  });

  it("part paid: what has come in and what is still owing", () => {
    const html = rowHtml(sent({ display: "part_paid", xeroAmountPaidCents: 20_000_00, xeroAmountDueCents: 35_000_00 }));
    expect(html).toContain("Part paid");
    expect(html).toContain("$20,000.00 paid · $35,000.00 owing (inc GST)");
  });

  it("overdue: says so, and still shows what is owing", () => {
    const html = rowHtml(sent({ display: "overdue", xeroAmountPaidCents: 20_000_00, xeroAmountDueCents: 35_000_00 }));
    expect(html).toContain("Overdue");
    expect(html).toContain("$35,000.00 owing (inc GST)");
  });

  it("paid: paid in full, with the day Xero recorded", () => {
    const html = rowHtml(sent({ display: "paid", xeroStatus: "PAID", xeroAmountPaidCents: 55_000_00, xeroAmountDueCents: 0, xeroFullyPaidOn: "2026-12-10" }));
    expect(html).toContain(">Paid<");
    expect(html).toContain("Paid in full on 10 Dec 2026.");
    expect(html).not.toContain("owing");
  });

  it("uses Xero's due date when the office changed it there", () => {
    expect(rowHtml(sent({ xeroDueDate: "2027-01-15" }))).toContain("due 15 Jan 2027");
  });

  it("a draft makes no claim about payment", () => {
    const html = rowHtml(sent({ display: "draft_in_xero", xeroStatus: "DRAFT" }));
    expect(html).toContain("Draft in Xero");
    expect(html).not.toContain("gp-stage-paid");
  });

  for (const [status, display, word] of [["DELETED", "deleted_in_xero", "deleted"], ["VOIDED", "voided", "voided"]] as const) {
    it(`${word} in Xero: struck through, said plainly, no payment line, and Raise again offered`, () => {
      const html = rowHtml(sent({ display, xeroStatus: status, xeroAmountDueCents: 0, canRaiseAgain: true, drift: { mismatches: ["subtotal"] } }));
      expect(html).toContain(STATUS_LABEL[display]);
      expect(html).toContain(`This invoice was ${word} in Xero, so it no longer counts toward the job.`);
      expect(html).toContain("Its number isn’t used again.");
      expect(html).toContain("line-through");
      expect(html).toContain("gp-stage-raise-dead");
      expect(html).toContain("Raise again");
      expect(html).not.toContain("gp-stage-paid");
      expect(html).not.toContain("gp-stage-drift"); // a dead invoice isn't "changed"
      expect(html).not.toContain(" · due ");
      expect(html).toContain("Open in Xero"); // still there to look at
    });
  }

  it("once raised again: says so and offers nothing more", () => {
    const html = rowHtml(sent({ display: "deleted_in_xero", xeroStatus: "DELETED", canRaiseAgain: false, replacedById: "s2" }));
    expect(html).toContain("It has been raised again as a new stage.");
    expect(html).not.toContain("Raise again");
  });

  it("Xero has nothing under the stored id: says the figures are the last ones Xero gave", () => {
    const html = rowHtml(sent({ drift: { mismatches: ["not_found_in_xero"] } }));
    expect(html).toContain("Xero no longer has this invoice under the id BuhlOS stored.");
    expect(html).toContain("the last ones Xero gave");
    expect(html).not.toContain("has been changed in Xero");
  });

  it("no state after a send offers Edit, Remove or Send", () => {
    for (const s of [sent(), sent({ display: "paid", xeroStatus: "PAID" }), sent({ display: "voided", xeroStatus: "VOIDED", canRaiseAgain: true })]) {
      const html = rowHtml(s);
      for (const label of [">Edit<", ">Remove<", "Send to Xero", "Try again", "Edit and resend"]) expect(html).not.toContain(label);
    }
  });

  it("every status has a label and a tone", () => {
    for (const k of Object.keys(STATUS_LABEL) as Array<keyof typeof STATUS_LABEL>) {
      expect(STATUS_LABEL[k].length).toBeGreaterThan(3);
      expect(STATUS_TONE[k]).toBeTruthy();
    }
    expect(STATUS_TONE.overdue).toBe("danger");
    expect(STATUS_TONE.paid).toBe("success");
  });
});

function job(stages: Stage[], totals: Partial<JobInvoicingResponse["totals"]>, statusAsOf: string | null = new Date().toISOString()): JobInvoicingResponse {
  return {
    jobId: "tower",
    job: { name: "Tower Fit-out", code: "IV3345", clientName: "Built Pty Ltd", contractCents: 250_000_00 },
    profile: { jobId: "tower", retentionBp: 0, xeroContactId: "c", xeroContactName: "Built Pty Ltd", externalTenantId: "org-1", version: 2 },
    stages,
    totals: {
      contractCents: 250_000_00, plannedCount: 0, plannedGrossCents: 0, plannedNetCents: 0, unresolvedCount: 0,
      sentCount: 0, claimedCents: 0, stillToInvoiceCents: 250_000_00, overContract: false, retentionHeldCents: 0,
      draftedCents: 0, invoicedCents: 0, paidCents: 0, paidIncGstCents: 0, dueIncGstCents: 0,
      ...totals,
    },
    xero: { state: "connected", organisationName: "Buhl Electrical", settingsComplete: true, sendReady: true, client: { linked: true, name: "Built Pty Ltd", otherOrganisation: false, suggestion: null } },
    statusAsOf,
    asOf: "2026-12-01T00:00:00.000Z",
  };
}
const cardHtml = (data: JobInvoicingResponse) => render(createElement(JobGettingPaidBody, { data, onData: noop, onStale: noop }));

describe("Getting paid — the money-in strip", () => {
  it("isn't shown until something has been sent", () => {
    const html = cardHtml(job([], {}, null));
    expect(html).not.toContain("gp-money-in");
    expect(html).not.toContain("Check Xero now");
  });

  it("shows approved, paid and owing — Xero's figures, with how fresh they are and a Check Xero now button", () => {
    const html = cardHtml(job(
      [
        sent({ id: "a", display: "paid", xeroStatus: "PAID", xeroAmountPaidCents: 55_000_00, xeroAmountDueCents: 0 }),
        sent({ id: "b", seq: 2, invoiceNumber: "IV3345-2", display: "overdue", xeroSubtotalCents: 20_000_00, xeroTaxCents: 2_000_00, xeroTotalCents: 22_000_00, xeroAmountDueCents: 22_000_00 }),
        sent({ id: "c", seq: 3, invoiceNumber: "IV3345-3", display: "draft_in_xero", xeroStatus: "DRAFT", xeroSubtotalCents: 10_000_00 }),
      ],
      { sentCount: 3, claimedCents: 80_000_00, stillToInvoiceCents: 170_000_00, draftedCents: 10_000_00, invoicedCents: 70_000_00, paidCents: 50_000_00, paidIncGstCents: 55_000_00, dueIncGstCents: 22_000_00 },
    ));
    expect(html).toContain("gp-money-in");
    expect(html).toContain("Approved in Xero");
    expect(html).toContain("$70,000.00");
    expect(html).toContain("$10,000.00 more is still a draft");
    expect(html).toContain("$55,000.00");
    expect(html).toContain("inc GST · $50,000.00 ex GST");
    expect(html).toContain("$22,000.00");
    expect(html).toContain("inc GST · 1 overdue");
    expect(html).toContain("These are Xero’s figures, last checked just now. BuhlOS checks every hour.");
    expect(html).toContain("Check Xero now");
  });

  it("only drafts so far: nothing is called approved, paid or owing", () => {
    const html = cardHtml(job([sent({ display: "draft_in_xero", xeroStatus: "DRAFT" })], { sentCount: 1, claimedCents: 50_000_00, stillToInvoiceCents: 200_000_00, draftedCents: 50_000_00 }));
    expect(html).toContain("$50,000.00 more is still a draft");
    expect(html).toContain("nothing paid yet");
    expect(html).toContain("inc GST · on approved invoices");
  });

  it("says when the figures have never been checked", () => {
    expect(cardHtml(job([sent()], { sentCount: 1 }, null))).toContain("last checked not checked yet");
  });
});

const moneyIn = (over: Partial<NonNullable<JobProfitabilityResponse["customerInvoices"]>> = {}): NonNullable<JobProfitabilityResponse["customerInvoices"]> => ({
  unavailable: false, sentCount: 2, plannedCount: 1, draftedCents: 0, invoicedCents: 70_000_00, paidCents: 50_000_00, paidIncGstCents: 55_000_00,
  dueIncGstCents: 22_000_00, stillToInvoiceCents: 180_000_00, retentionHeldCents: 0, overdueCount: 0, cashCents: 12_345_00, asOf: "2026-12-01T00:00:00.000Z",
  ...over,
});
const noteHtml = (m: JobProfitabilityResponse["customerInvoices"], labourUnderstated = false) => render(createElement(MoneyInNote, { moneyIn: m, labourUnderstated }));
/** The note as a reader sees it: the words, without the markup around each figure. */
const noteText = (m: JobProfitabilityResponse["customerInvoices"], labourUnderstated = false) => noteHtml(m, labourUnderstated).replace(/<[^>]+>/g, "");

describe("Money card — money in", () => {
  it("renders nothing at all while the feature is off", () => {
    expect(noteHtml(null)).toBe("");
  });

  it("invoiced, paid and owing, and cash so far against the job's costs", () => {
    const text = noteText(moneyIn());
    expect(text).toContain("Money in: $70,000.00 invoiced · $55,000.00 paid · $22,000.00 owing.");
    expect(text).toContain("Invoiced is ex GST and counts invoices approved in Xero; paid and owing include GST, as Xero shows them.");
    expect(text).toContain("Cash so far: $12,345.00 — what has been paid (ex GST) less labour and materials to date.");
    expect(noteHtml(moneyIn())).toContain("text-state-success-subtle-text");
    expect(text).not.toContain("still a draft");
  });

  it("a job that has cost more than it has been paid shows the shortfall in the warning colour", () => {
    const html = noteHtml(moneyIn({ cashCents: -4_000_00 }));
    expect(html.replace(/<[^>]+>/g, "")).toContain("Cash so far: -$4,000.00");
    expect(html).toContain("text-state-danger-subtle-text");
  });

  it("names uncosted labour beside the cash figure rather than overstating it", () => {
    expect(noteText(moneyIn(), true)).toContain("less labour and materials to date, before uncosted labour.");
  });

  it("counts overdue invoices and mentions drafts", () => {
    const html = noteText(moneyIn({ overdueCount: 2, draftedCents: 10_000_00 }));
    expect(html).toContain("owing (2 overdue).");
    expect(html).toContain("Another $10,000.00 is still a draft in Xero.");
  });

  it("when the paid amount can't be split out, says cash can't be worked out — never a guess", () => {
    const html = noteHtml(moneyIn({ paidCents: null, cashCents: null }));
    expect(html).toContain("money-in-cash-unknown");
    expect(html).toContain("Cash so far can’t be worked out");
    expect(html).not.toContain('data-testid="money-in-cash"');
  });

  it("nothing sent yet: says so, and points at the planned stages", () => {
    expect(noteHtml(moneyIn({ sentCount: 0, plannedCount: 2 }))).toContain("Money in: nothing has been invoiced on this job yet — 2 stages are planned in Getting paid below.");
    expect(noteHtml(moneyIn({ sentCount: 0, plannedCount: 1 }))).toContain("1 stage is planned");
    expect(noteHtml(moneyIn({ sentCount: 0, plannedCount: 0 }))).toContain("nothing has been invoiced on this job yet.");
  });

  it("when the invoices couldn't be read: says so — that is not the same as nothing invoiced", () => {
    const html = noteHtml(moneyIn({ unavailable: true, sentCount: 0 }));
    expect(html).toContain("couldn’t be read just now");
    expect(html).toContain("not the same as nothing invoiced");
    expect(html).not.toContain("$");
  });
});

describe("words", () => {
  const now = new Date("2026-12-01T12:00:00Z");
  it("agoLabel", () => {
    expect(agoLabel(null, now)).toBe("not checked yet");
    expect(agoLabel("nonsense", now)).toBe("not checked yet");
    expect(agoLabel("2026-12-01T11:59:50Z", now)).toBe("just now");
    expect(agoLabel("2026-12-01T11:59:00Z", now)).toBe("1 minute ago");
    expect(agoLabel("2026-12-01T11:20:00Z", now)).toBe("40 minutes ago");
    expect(agoLabel("2026-12-01T11:00:00Z", now)).toBe("1 hour ago");
    expect(agoLabel("2026-11-30T12:00:00Z", now)).toBe("24 hours ago");
    expect(agoLabel("2026-11-27T12:00:00Z", now)).toBe("4 days ago");
    expect(agoLabel("2026-12-02T12:00:00Z", now)).toBe("just now"); // a clock ahead is not "in the future"
  });

  it("refreshMessage says what the check found", () => {
    expect(refreshMessage({ checked: 0, changed: 0, notFound: 0 }).text).toContain("nothing to check");
    expect(refreshMessage({ checked: 1, changed: 0, notFound: 0 })).toEqual({ tone: "success", text: "Checked 1 invoice with Xero. Nothing has changed." });
    expect(refreshMessage({ checked: 3, changed: 1, notFound: 0 }).text).toBe("Checked 3 invoices with Xero. 1 has changed — the figures below are up to date.");
    expect(refreshMessage({ checked: 3, changed: 2, notFound: 0 }).text).toContain("2 have changed");
    expect(refreshMessage({ checked: 3, changed: 1, notFound: 1 })).toEqual({ tone: "warning", text: "Checked 3 invoices. Xero no longer has one of them — see below." });
    expect(refreshMessage({ checked: 3, changed: 2, notFound: 2 }).text).toContain("2 of them");
  });

  it("the payment-check row stays off the sync panel until it has been used", () => {
    expect(XERO_SYNC_TYPES).toContain("invoice_status");
    expect(QUIET_UNTIL_USED.has("invoice_status")).toBe(true);
  });
});
