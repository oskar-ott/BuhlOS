import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { JobGettingPaidBody } from "./JobGettingPaidCard";
import { SendPreviewView } from "./SendToXeroPreview";
import { StageRow, type StageRowActions } from "./StageRow";
import {
  blockerMessage,
  failureMessage,
  sendOutcomeMessage,
  xeroInvoiceUrl,
} from "@/domains/customer-invoices/format";
import {
  SEND_BLOCKER_CODES,
  SEND_OUTCOMES,
  type JobInvoicingResponse,
  type SendPreview,
  type Stage,
} from "@/domains/customer-invoices/schema";

/**
 * Sending a stage to Xero (#1150) — the preview, and every state a row can be
 * in on its way there. The states that matter most are the unhappy ones: a
 * stage Xero refused must show Xero's own reason and the safe next step, and a
 * stage with no answer must say plainly that it may or may not be in Xero.
 */
const noop = () => {};
const render = (el: ReactElement) => renderToString(el).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");
const actions: StageRowActions = {
  onEdit: noop, onAskRemove: noop, onCancelRemove: noop, onRemove: noop, onSend: noop, onCheck: noop, onReset: noop, onRaiseAgain: noop,
};

function stage(over: Partial<Stage> = {}): Stage {
  return {
    id: "s1", jobId: "tower", kind: "stage", seq: null, invoiceNumber: null, title: "Deposit", basis: "percent", percentBp: 2000,
    amountCents: null, extraLines: [], retentionBp: null, plannedDate: null, note: null, state: "planned", version: 1,
    computed: { grossCents: 50_000_00, retentionBp: 0, retentionCents: 0, netCents: 50_000_00, reason: null },
    display: "planned",
    ...over,
  };
}
const rowHtml = (s: Stage, opts: { sendReady?: boolean; busy?: boolean; confirmingRemove?: boolean } = {}) =>
  render(createElement(StageRow, { stage: s, busy: !!opts.busy, confirmingRemove: !!opts.confirmingRemove, sendReady: opts.sendReady ?? true, actions }));

describe("StageRow — planned", () => {
  it("offers Send to Xero beside Edit and Remove when the job is ready", () => {
    const html = rowHtml(stage());
    expect(html).toContain("Send to Xero");
    expect(html).toContain("Edit");
    expect(html).toContain("Remove");
  });

  it("offers no Send when the job isn't ready, or the stage has no amount to invoice", () => {
    expect(rowHtml(stage(), { sendReady: false })).not.toContain("Send to Xero");
    const unresolved = stage({ computed: { grossCents: null, retentionBp: 0, retentionCents: null, netCents: null, reason: "no_contract_value" } });
    expect(rowHtml(unresolved)).not.toContain("Send to Xero");
    expect(rowHtml(unresolved)).toContain("needs a contract value");
  });

  it("while confirming a removal, shows only the yes / keep choice", () => {
    const html = rowHtml(stage(), { confirmingRemove: true });
    expect(html).toContain("Yes, remove");
    expect(html).not.toContain("Send to Xero");
  });
});

describe("StageRow — on its way to Xero", () => {
  const frozen = { seq: 1, invoiceNumber: "IV3345-1", invoiceDate: "2026-11-22", dueDate: "2026-12-22" };

  it("no answer from Xero: says it may or may not be there and offers a CHECK, never a blind resend", () => {
    const html = rowHtml(stage({ ...frozen, state: "sending", display: "sending", failureCategory: "timeout" }));
    expect(html).toContain("IV3345-1");
    expect(html).toContain("may or may not be there");
    expect(html).toContain("won't be sent twice");
    expect(html).toContain("Check Xero");
    expect(html).not.toContain("Send to Xero");
    expect(html).not.toContain(">Edit<");
  });

  it("refused by Xero: shows Xero's own sentence, with Try again and Edit and resend", () => {
    const html = rowHtml(stage({ ...frozen, state: "failed", display: "failed", failureCategory: "validation", failureDetail: "Account code '999' is not a valid code for this document." }));
    expect(html).toContain("Couldn't send");
    expect(html).toContain("Xero refused it: Account code '999' is not a valid code for this document.");
    expect(html).toContain("Try again");
    expect(html).toContain("Edit and resend");
    expect(html).not.toContain("Use the next number");
  });

  it("number taken in Xero: the only way on is the next number", () => {
    const html = rowHtml(stage({ ...frozen, state: "failed", display: "failed", failureCategory: "number_taken", failureDetail: "Xero already has a different invoice with this number" }));
    expect(html).toContain("Xero already has a different invoice with this number. Use the next number instead.");
    expect(html).toContain("Use the next number");
    expect(html).not.toContain("Try again");
    expect(html).not.toContain("Edit and resend");
  });

  it("busy: the buttons say what is happening", () => {
    expect(rowHtml(stage({ ...frozen, state: "sending", display: "sending", failureCategory: "timeout" }), { busy: true })).toContain("Checking Xero…");
  });
});

describe("StageRow — sent", () => {
  const sent = (over: Partial<Stage> = {}) =>
    stage({
      state: "sent", display: "draft_in_xero", seq: 2, invoiceNumber: "IV3345-2", invoiceDate: "2026-11-30", dueDate: "2026-12-30",
      xeroInvoiceId: "aaaaaaaa-0000-4000-8000-000000000001", xeroStatus: "DRAFT",
      xeroSubtotalCents: 12_540_47, xeroTaxCents: 1_254_05, xeroTotalCents: 13_794_52,
      computed: { grossCents: 13_200_50, retentionBp: 500, retentionCents: 660_03, netCents: 12_540_47, reason: null },
      ...over,
    });

  it("shows the number, XERO'S figures labelled as Xero's, the dates, the retention held and a link into Xero", () => {
    const html = rowHtml(sent());
    expect(html).toContain("IV3345-2");
    expect(html).toContain("Draft in Xero");
    expect(html).toContain("$12,540.47");
    expect(html).toContain("+ $1,254.05 GST = $13,794.52 · Xero's figures");
    expect(html).toContain("dated 30 Nov 2026");
    expect(html).toContain("due 30 Dec 2026");
    expect(html).toContain("$660.03 retention held (5%)");
    expect(html).toContain('href="https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=aaaaaaaa-0000-4000-8000-000000000001"');
    expect(html).toContain("Open in Xero");
  });

  it("offers nothing that would change it — no Edit, Remove, Send, or resend", () => {
    const html = rowHtml(sent());
    for (const label of [">Edit<", ">Remove<", "Send to Xero", "Try again", "Check Xero", "Edit and resend"]) {
      expect(html).not.toContain(label);
    }
  });

  it("says so, loudly, when what is in Xero doesn't match what was sent", () => {
    const html = rowHtml(sent({ drift: { mismatches: ["subtotal"] } }));
    expect(html).toContain("gp-stage-drift");
    expect(html).toContain("doesn’t match what BuhlOS sent");
  });
});

const preview = (over: Partial<SendPreview> = {}): SendPreview => ({
  blockers: [],
  invoice: {
    invoiceNumber: "IV3345-2", organisationName: "Buhl Electrical", contactName: "Built Pty Ltd",
    invoiceDate: "2026-11-30", dueDate: "2026-12-30", reference: "IV3345 Tower Fit-out",
    lines: [
      { description: "November claim\nTower Fit-out, 12 Smith St", amountCents: 12_000_50 },
      { description: "Variation 3", amountCents: 1_200_00 },
      { description: "Less retention (5%)", amountCents: -660_03 },
    ],
    netCents: 12_540_47, estimatedTaxCents: 1_254_05, estimatedTotalCents: 13_794_52,
    salesAccountCode: "200", salesAccountName: "Sales", taxName: "GST on Income", taxRateBp: 1000,
  },
  ...over,
});
const previewHtml = (p: SendPreview) =>
  render(createElement(SendPreviewView, { preview: p, invoiceDate: "2026-11-30", reference: p.invoice?.reference ?? "", busy: false, onDate: noop, onReference: noop }));

describe("SendPreviewView", () => {
  it("shows exactly what will be created: who, number, due date, coding, every line and the subtotal", () => {
    const html = previewHtml(preview());
    expect(html).toContain("Built Pty Ltd");
    expect(html).toContain("in Buhl Electrical");
    expect(html).toContain("IV3345-2");
    expect(html).toContain("30 Dec 2026");
    expect(html).toContain("200 — Sales · GST on Income (10%)");
    expect(html).toContain("November claim");
    expect(html).toContain("$12,000.50");
    expect(html).toContain("Variation 3");
    expect(html).toContain("Less retention (5%)");
    expect(html).toContain("-$660.03");
    expect(html).toContain("$12,540.47");
    expect(html).toContain('value="IV3345 Tower Fit-out"');
  });

  it("labels the GST and total as an ESTIMATE of what Xero will add", () => {
    const html = previewHtml(preview());
    expect(html).toContain("GST Xero is expected to add, and the total (estimate)");
    expect(html).toContain("$1,254.05 · $13,794.52");
  });

  it("says it creates a draft and that BuhlOS never approves or emails", () => {
    const html = previewHtml(preview());
    expect(html).toContain("draft");
    expect(html).toContain("The client sees nothing until you approve and email it from Xero.");
    expect(html).toContain("BuhlOS never approves or emails an invoice.");
  });

  it("names every blocker in plain words", () => {
    const html = previewHtml(preview({ blockers: [{ code: "no_client_link" }, { code: "settings_incomplete" }], invoice: null }));
    expect(html).toContain("send-blockers");
    expect(html).toContain("This can’t be sent yet:");
    expect(html).toContain(blockerMessage("no_client_link"));
    expect(html).toContain("aren't chosen yet");
  });

  it("can show the invoice AND what is blocking it", () => {
    const html = previewHtml(preview({ blockers: [{ code: "xero_not_ready" }] }));
    expect(html).toContain("send-blockers");
    expect(html).toContain("IV3345-2");
  });
});

describe("words for every outcome and blocker", () => {
  it("has plain words for every blocker code — never the code itself", () => {
    for (const code of SEND_BLOCKER_CODES) {
      const msg = blockerMessage(code);
      expect(msg.length, code).toBeGreaterThan(15);
      expect(msg, code).not.toContain(code);
    }
    expect(blockerMessage("something_new")).toBe("This stage can't be sent yet.");
  });

  it("has a line and a tone for every send outcome", () => {
    const base = { invoiceNumber: "IV3345-1", verified: true, category: null, detail: null };
    for (const outcome of SEND_OUTCOMES) expect(sendOutcomeMessage({ ...base, outcome }).text.length).toBeGreaterThan(20);
    expect(sendOutcomeMessage({ ...base, outcome: "sent" })).toEqual({ tone: "success", text: "IV3345-1 is in Xero as a draft. Approve and email it from Xero." });
    expect(sendOutcomeMessage({ ...base, outcome: "sent", verified: false }).tone).toBe("warning");
    expect(sendOutcomeMessage({ ...base, outcome: "adopted" }).text).toContain("nothing was sent twice");
    expect(sendOutcomeMessage({ ...base, outcome: "unknown" }).tone).toBe("warning");
    expect(sendOutcomeMessage({ ...base, outcome: "failed", category: "validation", detail: "Bad account" })).toEqual({ tone: "danger", text: "Xero refused it: Bad account" });
  });

  it("tells a refusal that created nothing apart from one that needs a reconnect", () => {
    expect(failureMessage("rate_limit", null)).toContain("Nothing was created");
    expect(failureMessage("reconnect_required", null)).toContain("Reconnect Xero");
    expect(failureMessage("validation", null)).toBe("Xero refused this invoice as invalid.");
    expect(failureMessage(null, null)).toContain("Nothing was created in Xero");
  });

  it("builds the Xero link from the invoice id only", () => {
    expect(xeroInvoiceUrl("a b/c")).toBe("https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=a%20b%2Fc");
  });
});

describe("Getting paid — with stages in Xero", () => {
  const data: JobInvoicingResponse = {
    jobId: "tower",
    job: { name: "Tower Fit-out", code: "IV3345", clientName: "Built Pty Ltd", contractCents: 250_000_00 },
    profile: { jobId: "tower", retentionBp: 500, xeroContactId: "c", xeroContactName: "Built Pty Ltd", externalTenantId: "org-1", version: 2 },
    stages: [
      stage({ id: "a", state: "sent", display: "draft_in_xero", seq: 1, invoiceNumber: "IV3345-1", xeroInvoiceId: "x1", xeroSubtotalCents: 95_000_00, xeroTaxCents: 9_500_00, xeroTotalCents: 104_500_00,
        computed: { grossCents: 100_000_00, retentionBp: 500, retentionCents: 5_000_00, netCents: 95_000_00, reason: null } }),
      stage({ id: "b", title: "Fit-off" }),
    ],
    totals: {
      contractCents: 250_000_00, plannedCount: 1, plannedGrossCents: 50_000_00, plannedNetCents: 47_500_00, unresolvedCount: 0,
      sentCount: 1, claimedCents: 100_000_00, stillToInvoiceCents: 150_000_00, overContract: false, retentionHeldCents: 5_000_00,
    },
    xero: { state: "connected", organisationName: "Buhl Electrical", settingsComplete: true, sendReady: true, client: { linked: true, name: "Built Pty Ltd", otherOrganisation: false, suggestion: null } },
    asOf: "2026-11-22T00:00:00.000Z",
  };
  const html = render(createElement(JobGettingPaidBody, { data, onData: noop, onStale: noop }));

  it("shows what has been sent against the contract, and what is still to invoice", () => {
    expect(html).toContain("Sent to Xero");
    expect(html).toContain("$100,000.00");
    expect(html).toContain("1 invoice · before retention");
    expect(html).toContain("$150,000.00");
    expect(html).toContain("$100,000.00 not yet planned");
  });

  it("shows the retention held and offers to release it", () => {
    expect(html).toContain("Retention held so far:");
    expect(html).toContain("$5,000.00");
    expect(html).toContain("Release retention");
  });

  it("the sent row is closed to editing while the planned one can still be sent", () => {
    expect(html).toContain("IV3345-1");
    expect(html.match(/Send to Xero/g)).toHaveLength(1);
    expect(html).not.toMatch(/>Paid</);
  });
});
