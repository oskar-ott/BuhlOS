import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ItemisedEditor } from "./ItemisedEditor";
import { NoJobInvoicesBody, canSend } from "./NoJobInvoices";
import { StageRow } from "./StageRow";
import { NAV_GROUPS, visibleNavGroups } from "../nav";
import { blockerMessage, errorMessage } from "@/domains/customer-invoices/format";
import {
  NO_JOB_ID,
  type InvoiceItem,
  type JobInvoicingResponse,
  type Stage,
} from "@/domains/customer-invoices/schema";

/**
 * The Getting paid page — invoices with NO job (#1166). Every state is a pure
 * function of its props, so each is pinned here as the office would read it:
 * who the invoice is for, what stops it being sent, and that no figure is
 * shown until Xero has given one.
 */
const noop = () => {};
const render = (el: Parameters<typeof renderToString>[0]) => renderToString(el).replace(/<!-- -->/g, "");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;|’/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const ITEMS: InvoiceItem[] = [
  { id: "a", type: "line", description: "Tower fit-out, claim 4", quantityMilli: 1000, unit: "ea", unitCents: 1250000, amountCents: 1250000, source: "manual", costCents: null, refs: [] },
  { id: "n", type: "note", description: "As per payment schedule 4." },
];

function invoice(over: Partial<Stage> = {}): Stage {
  return {
    id: "s1", jobId: NO_JOB_ID, kind: "itemised", seq: null, invoiceNumber: null, title: "Progress claim, November 2026",
    basis: "amount", percentBp: null, amountCents: 1250000, extraLines: [], retentionBp: null, plannedDate: null, note: null,
    state: "planned", version: 1,
    computed: { grossCents: 1250000, retentionBp: 0, retentionCents: 0, netCents: 1250000, reason: null },
    display: "planned",
    items: ITEMS,
    itemsSummary: { lineCount: 1, totalCents: 1250000, costCents: 0, costedSellCents: 0, costKnown: true },
    clientContactId: "c1", clientContactName: "Built Pty Ltd", clientOtherOrganisation: false,
    ...over,
  };
}

function data(over: Partial<JobInvoicingResponse> = {}): JobInvoicingResponse {
  return {
    jobId: NO_JOB_ID,
    noJob: true,
    job: { name: "Invoices with no job", code: null, clientName: null, contractCents: null },
    profile: { jobId: NO_JOB_ID, retentionBp: 0, xeroContactId: null, xeroContactName: null, externalTenantId: null, version: null },
    stages: [],
    variations: [],
    totals: {
      contractCents: null, plannedCount: 0, plannedGrossCents: 0, plannedNetCents: 0, unresolvedCount: 0, sentCount: 0,
      claimedCents: 0, stillToInvoiceCents: null, overContract: false, retentionHeldCents: 0,
      draftedCents: 0, invoicedCents: 0, paidCents: 0, paidIncGstCents: 0, dueIncGstCents: 0,
    },
    xero: { state: "connected", organisationName: "Buhl Electrical", settingsComplete: true, sendReady: true, client: { linked: false, name: null, otherOrganisation: false, suggestion: null } },
    statusAsOf: null,
    asOf: "2026-11-25T00:00:00.000Z",
    ...over,
  };
}
const page = (d: JobInvoicingResponse) => render(createElement(NoJobInvoicesBody, { data: d, onData: noop, onStale: noop }));

describe("Getting paid — the list of invoices with no job", () => {
  it("empty: says what the page is for, offers New invoice, and shows no figures", () => {
    const html = page(data());
    const t = text(html);
    expect(t).toContain("No invoices here yet.");
    expect(t).toContain("one invoice a month against a builder's payment schedule");
    expect(t).toContain("New invoice");
    expect(t).toContain("An invoice is sent to Xero as a draft. Approve and email it from Xero");
    expect(html).not.toContain("no-job-money-in");
    expect(html).not.toContain("$"); // nothing sent, so nothing totalled
    expect(html).not.toContain("no-job-xero-blocked");
  });

  it("says plainly when Xero can't take an invoice, and that one can still be written", () => {
    const off = text(page(data({ xero: { ...data().xero, state: "disconnected", sendReady: false } })));
    expect(off).toContain("Xero isn't connected. You can still write an invoice; it can't be sent until this is fixed.");
    expect(off).toContain("Connect Xero");
    const perm = text(page(data({ xero: { ...data().xero, state: "missing_permission", sendReady: false } })));
    expect(perm).toContain("Xero is connected, but without permission for invoices.");
    expect(perm).toContain("Reconnect Xero to allow invoices");
    const unset = page(data({ xero: { ...data().xero, settingsComplete: false, sendReady: false } }));
    expect(text(unset)).toContain("The sales account, GST rate and payment terms aren't chosen yet, so an invoice can't be sent.");
    expect(unset).toContain('href="/settings/integrations/xero"');
  });

  it("a planned invoice names who it is for and can be sent", () => {
    const html = page(data({ stages: [invoice()], totals: { ...data().totals, plannedCount: 1, plannedGrossCents: 1250000, plannedNetCents: 1250000 } }));
    const t = text(html);
    expect(t).toContain("Progress claim, November 2026");
    expect(t).toContain("For Built Pty Ltd");
    expect(t).toContain("Tower fit-out, claim 4");
    expect(t).toContain("$12,500.00");
    for (const b of ["Edit", "Remove", "Send to Xero"]) expect(t).toContain(b);
    expect(html).not.toContain("no-job-money-in"); // still nothing sent
  });

  it("no client: says so on the row and offers no Send", () => {
    const html = page(data({ stages: [invoice({ clientContactId: null, clientContactName: null })] }));
    const t = text(html);
    expect(t).toContain("No client chosen yet");
    expect(html).not.toContain("gp-stage-send");
    expect(t).toContain("Edit");
  });

  it("a client chosen in another Xero organisation has to be chosen again", () => {
    const html = page(data({ stages: [invoice({ clientOtherOrganisation: true })] }));
    expect(text(html)).toContain("For Built Pty Ltd · chosen in a different Xero organisation, choose it again");
    expect(html).not.toContain("gp-stage-send");
  });

  it("no Send while Xero isn't ready, even with a client", () => {
    const d = data({ stages: [invoice()], xero: { ...data().xero, settingsComplete: false, sendReady: false } });
    expect(page(d)).not.toContain("gp-stage-send");
    expect(canSend(d, d.stages[0]!)).toBe(false);
    expect(canSend(data(), invoice())).toBe(true);
    expect(canSend(data(), invoice({ clientContactId: null }))).toBe(false);
    expect(canSend(data(), invoice({ clientOtherOrganisation: true }))).toBe(false);
  });

  it("once something is sent, Xero's figures show with how fresh they are and a way to check now", () => {
    const sent = invoice({
      state: "sent", display: "part_paid", seq: 1, invoiceNumber: "GEN-0001", invoiceDate: "2026-11-25", dueDate: "2026-12-09",
      xeroStatus: "AUTHORISED", xeroSubtotalCents: 1250000, xeroTaxCents: 125000, xeroTotalCents: 1375000,
      xeroAmountPaidCents: 500000, xeroAmountDueCents: 875000, xeroInvoiceId: "x1",
    });
    const html = page(data({
      stages: [sent], statusAsOf: "2026-11-25T00:00:00.000Z",
      totals: { ...data().totals, sentCount: 1, claimedCents: 1250000, invoicedCents: 1250000, paidCents: 454545, paidIncGstCents: 500000, dueIncGstCents: 875000 },
    }));
    const t = text(html);
    expect(t).toContain("GEN-0001");
    expect(t).toContain("Approved in Xero");
    expect(t).toContain("$5,000.00 paid · $8,750.00 owing (inc GST)");
    expect(t).toContain("These are Xero's figures, last checked");
    expect(t).toContain("Check Xero now");
    expect(html).toContain("no-job-paid");
    expect(html).toContain("no-job-owing");
  });

  it("deleted in Xero: wording doesn't talk about a job", () => {
    const dead = invoice({ state: "sent", display: "deleted_in_xero", seq: 1, invoiceNumber: "GEN-0001", xeroStatus: "DELETED", xeroInvoiceId: "x1", canRaiseAgain: true } as Partial<Stage>);
    const row = text(render(createElement(StageRow, {
      stage: dead, busy: false, confirmingRemove: false, sendReady: true,
      actions: { onEdit: noop, onAskRemove: noop, onCancelRemove: noop, onRemove: noop, onSend: noop, onCheck: noop, onReset: noop, onRaiseAgain: noop },
    })));
    expect(row).toContain("This invoice was deleted in Xero, so it no longer counts. Its number isn't used again.");
    expect(row).not.toContain("toward the job");
  });

  it("a job's own invoice row is unchanged: no client line, and it still talks about the job", () => {
    const onJob = invoice({ jobId: "shop", clientContactId: null, clientContactName: null, state: "sent", display: "deleted_in_xero", seq: 1, invoiceNumber: "IV7001-1", xeroStatus: "DELETED", xeroInvoiceId: "x1" } as Partial<Stage>);
    const html = render(createElement(StageRow, {
      stage: onJob, busy: false, confirmingRemove: false, sendReady: true,
      actions: { onEdit: noop, onAskRemove: noop, onCancelRemove: noop, onRemove: noop, onSend: noop, onCheck: noop, onReset: noop, onRaiseAgain: noop },
    }));
    expect(html).not.toContain("gp-stage-client");
    expect(text(html)).toContain("so it no longer counts toward the job.");
  });
});

describe("the editor for an invoice with no job", () => {
  const editor = (s: Stage | null, canChoose = true) =>
    render(createElement(ItemisedEditor, {
      jobId: NO_JOB_ID, jobRetentionBp: 0, stage: s, noJob: { organisationName: "Buhl Electrical", canChoose },
      onClose: noop, onSaved: noop, onStale: noop,
    }));

  it("a new one: asks who it is for and what it is for, with typed lines only", () => {
    const html = editor(null);
    const t = text(html);
    expect(t).toContain("New invoice");
    expect(t).toContain("Who is it for?");
    expect(t).toContain("No client chosen yet");
    expect(t).toContain("Choose client");
    expect(t).toContain("Chosen from your Xero contacts. You can save without one and choose it before sending.");
    expect(t).toContain("What is this invoice for?");
    expect(html).toContain('placeholder="e.g. Progress claim, November 2026"');
    expect(t).toContain("It is also the invoice's reference in Xero unless you type another when you send it.");
    for (const b of ["Add a line", "Add a note", "Add invoice"]) expect(t).toContain(b);
    // no job, so nothing to pull from one
    expect(t).not.toContain("Add from this job");
    expect(t).not.toContain("What was the work?");
    expect(t).not.toContain("job's name and address");
    expect(html).not.toContain("$");
  });

  it("editing: its client and lines come back", () => {
    const t = text(editor(invoice()));
    expect(t).toContain("Edit invoice");
    expect(t).toContain("Built Pty Ltd");
    expect(t).toContain("Change client");
    expect(t).toContain("This invoice comes to $12,500.00 ex GST.");
    expect(t).not.toContain("retention");
  });

  it("a client from another Xero organisation is not carried into the form", () => {
    const t = text(editor(invoice({ clientOtherOrganisation: true })));
    expect(t).toContain("No client chosen yet");
    expect(t).toContain("Choose client");
  });

  it("says why no client can be chosen while Xero isn't connected, and that it can still be saved", () => {
    const html = editor(null, false);
    expect(text(html)).toContain("Xero isn't connected for invoices, so there are no contacts to choose from yet. You can save the invoice and choose the client later.");
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-testid="itemised-choose-client"|data-testid="itemised-choose-client"[^>]*disabled/);
  });

  it("a job's itemised invoice is unchanged: no client field, and Add from this job stays", () => {
    const html = render(createElement(ItemisedEditor, { jobId: "shop", jobRetentionBp: 0, stage: null, onClose: noop, onSaved: noop, onStale: noop }));
    const t = text(html);
    expect(t).toContain("What was the work?");
    expect(t).toContain("Add from this job");
    expect(t).toContain("This heads the invoice, with the job's name and address under it.");
    expect(t).not.toContain("Who is it for?");
    expect(html).not.toContain("itemised-client");
  });
});

describe("Getting paid — wording and the nav item", () => {
  it("names what stops an invoice with no job being sent", () => {
    expect(blockerMessage("no_client_chosen")).toBe("No client is chosen for this invoice. Edit it and choose the client.");
    expect(blockerMessage("client_chosen_other_organisation")).toContain("choose the client again");
    for (const code of ["no_job_itemised_only", "no_job_typed_lines_only", "no_job_no_retention", "client_is_the_jobs"]) {
      expect(errorMessage(code, 400)).toBe("That can't be saved on this kind of invoice. Check the lines and try again.");
    }
  });

  it("the nav item sits in the Jobs group behind customer_invoices and vanishes when hidden", () => {
    const jobs = NAV_GROUPS.find((g) => g.heading === "Jobs")!;
    const item = jobs.items.find((i) => i.href === "/getting-paid");
    expect(item).toMatchObject({ label: "Getting paid", flag: "customer_invoices" });
    expect(item?.countKey).toBeUndefined();
    const hidden = visibleNavGroups(["/getting-paid"]);
    expect(hidden.flatMap((g) => g.items).some((i) => i.href === "/getting-paid")).toBe(false);
  });
});
