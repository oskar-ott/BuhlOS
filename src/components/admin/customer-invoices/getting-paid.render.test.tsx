import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobGettingPaidBody, JobGettingPaidCard } from "./JobGettingPaidCard";
import { StageEditor, buildStageInput } from "./StageEditor";
import type {
  JobInvoicingResponse,
  Stage,
} from "@/domains/customer-invoices/schema";

/**
 * "Getting paid" on the job hub (customer_invoices, #1148). renderToString
 * skips the mount fetch, so the shell test pins the initial contract; the
 * body is a pure function of the payload, so every state is pinned here —
 * above all the honesty rules: a figure that can't be worked out is named,
 * never $0, and nothing on the card claims a Xero send that doesn't exist.
 */
const noop = () => {};
/** React separates adjacent text nodes with empty comments when it renders to
 *  a string; strip them so assertions read as the person would read the page. */
const render = (el: Parameters<typeof renderToString>[0]) =>
  renderToString(el).replace(/<!-- -->/g, "");

function stage(over: Partial<Stage> = {}): Stage {
  return {
    id: "s1",
    jobId: "tower",
    kind: "stage",
    seq: null,
    invoiceNumber: null,
    title: "Deposit",
    basis: "percent",
    percentBp: 2000,
    amountCents: null,
    extraLines: [],
    retentionBp: null,
    plannedDate: null,
    note: null,
    state: "planned",
    version: 1,
    computed: { grossCents: 50_000_00, retentionBp: 0, retentionCents: 0, netCents: 50_000_00, reason: null },
    display: "planned",
    ...over,
  };
}

function data(over: Partial<JobInvoicingResponse> = {}): JobInvoicingResponse {
  return {
    jobId: "tower",
    job: { name: "Tower Fit-out", code: "IV3345", clientName: "Built Pty Ltd", contractCents: 250_000_00 },
    profile: { jobId: "tower", retentionBp: 0, xeroContactId: null, xeroContactName: null, externalTenantId: null, version: null },
    stages: [],
    totals: {
      contractCents: 250_000_00,
      plannedCount: 0,
      plannedGrossCents: 0,
      plannedNetCents: 0,
      unresolvedCount: 0,
      sentCount: 0,
      claimedCents: 0,
      stillToInvoiceCents: 250_000_00,
      overContract: false,
      retentionHeldCents: 0,
    },
    asOf: "2026-11-22T00:00:00.000Z",
    ...over,
  };
}

const body = (d: JobInvoicingResponse) =>
  render(createElement(JobGettingPaidBody, { data: d, onData: noop, onStale: noop }));

describe("JobGettingPaidCard — initial render", () => {
  it("renders the title, the ex-GST framing and a skeleton — no figures before the data", () => {
    const html = render(createElement(JobGettingPaidCard, { jobId: "tower" }));
    expect(html).toContain("Getting paid");
    expect(html).toContain("ex GST");
    expect(html).toContain("getting-paid-skeleton");
    expect(html).not.toContain("$");
  });
});

describe("JobGettingPaidBody", () => {
  it("an untouched job: contract shown, nothing planned, all of it still to invoice, a prompt to add stages", () => {
    const html = body(data());
    expect(html).toContain("$250,000.00");
    expect(html).toContain("no stages yet");
    expect(html).toContain("gp-empty");
    expect(html).toContain("Add stage");
    expect(html).toContain("$250,000.00 not yet planned");
    expect(html).toContain("Retention: none on this job.");
  });

  it("says plainly that this is a plan only — and offers no Xero send, invoiced or paid", () => {
    const html = body(data({ stages: [stage()], totals: { ...data().totals, plannedCount: 1, plannedGrossCents: 50_000_00, plannedNetCents: 50_000_00 } }));
    expect(html).toContain("This is the plan only. Nothing is sent to Xero from here yet.");
    expect(html).not.toMatch(/Send to Xero/i);
    expect(html).not.toMatch(/>Invoiced</);
    expect(html).not.toMatch(/>Paid</);
  });

  it("with no contract value: dashes and the reason, never a zero", () => {
    const d = data({
      job: { ...data().job, contractCents: null },
      totals: { ...data().totals, contractCents: null, stillToInvoiceCents: null },
    });
    const html = body(d);
    expect(html).toContain("not set");
    expect(html).toContain("set the contract value on the Money card");
    expect(html).not.toContain("$0");
  });

  it("lists a planned % stage with what it works out to and Edit / Remove", () => {
    const html = body(data({
      stages: [stage({ plannedDate: "2026-12-01" })],
      totals: { ...data().totals, plannedCount: 1, plannedGrossCents: 50_000_00, plannedNetCents: 50_000_00 },
    }));
    expect(html).toContain("Deposit");
    expect(html).toContain("20% of contract");
    expect(html).toContain("planned for 1 Dec 2026");
    expect(html).toContain("$50,000.00");
    expect(html).toContain("Planned");
    expect(html).toContain("1 stage");
    expect(html).toContain("$200,000.00 not yet planned");
    expect(html).toContain("Edit");
    expect(html).toContain("Remove");
  });

  it("shows extra lines and the retention taken off a stage", () => {
    const html = body(data({
      profile: { ...data().profile, retentionBp: 500, version: 1 },
      stages: [stage({
        title: "November claim", basis: "amount", percentBp: null, amountCents: 12_000_00,
        extraLines: [{ description: "Variation 3", amountCents: 1_200_00 }],
        computed: { grossCents: 13_200_00, retentionBp: 500, retentionCents: 660_00, netCents: 12_540_00, reason: null },
      })],
    }));
    expect(html).toContain("fixed amount + 1 extra line");
    expect(html).toContain("Variation 3");
    expect(html).toContain("$1,200.00");
    expect(html).toContain("$13,200.00");
    expect(html).toContain("less 5% retention $660.00");
    expect(html).toContain("$12,540.00 to invoice");
    expect(html).toContain("Retention: 5% held back from each stage.");
  });

  it("a % stage that can't be worked out is named on the row and above the list", () => {
    const html = body(data({
      job: { ...data().job, contractCents: null },
      stages: [stage({ computed: { grossCents: null, retentionBp: 0, retentionCents: null, netCents: null, reason: "no_contract_value" } })],
      totals: { ...data().totals, contractCents: null, stillToInvoiceCents: null, plannedCount: 1, unresolvedCount: 1 },
    }));
    expect(html).toContain("needs a contract value");
    expect(html).toContain("gp-unresolved");
    expect(html).toContain("1 not worked out");
    expect(html).not.toContain("$0");
  });

  it("warns, without blocking, when the planned stages pass the contract", () => {
    const html = body(data({
      stages: [stage({ id: "a", percentBp: 6000, computed: { ...stage().computed, grossCents: 150_000_00, netCents: 150_000_00 } }), stage({ id: "b", percentBp: 6000, computed: { ...stage().computed, grossCents: 150_000_00, netCents: 150_000_00 } })],
      totals: { ...data().totals, plannedCount: 2, plannedGrossCents: 300_000_00, plannedNetCents: 300_000_00, overContract: true },
    }));
    expect(html).toContain("gp-over-contract");
    expect(html).toContain("$50,000.00 more than the contract");
    expect(html).toContain("Add stage");
  });

  it("a stage that has left 'planned' offers no Edit or Remove", () => {
    const html = body(data({ stages: [stage({ state: "sent", display: "draft_in_xero", seq: 1, invoiceNumber: "IV3345-1" })] }));
    expect(html).toContain("Draft in Xero");
    expect(html).not.toContain(">Edit<");
    expect(html).not.toContain(">Remove<");
  });
});

describe("StageEditor", () => {
  it("opens empty for a new stage, defaulting to a dollar amount", () => {
    const html = render(createElement(StageEditor, {
      jobId: "tower", contractCents: 250_000_00, jobRetentionBp: 0, stage: null, onClose: noop, onSaved: noop, onStale: noop,
    }));
    expect(html).toContain("Add a stage");
    expect(html).toContain("Amount ($ ex GST)");
    expect(html).toContain("Fill in the amount to see what this stage comes to.");
  });

  it("opens pre-filled for an edit and previews the amount with retention", () => {
    const html = render(createElement(StageEditor, {
      jobId: "tower", contractCents: 250_000_00, jobRetentionBp: 500, onClose: noop, onSaved: noop, onStale: noop,
      stage: stage({ extraLines: [{ description: "Variation 3", amountCents: 1_200_00 }] }),
    }));
    expect(html).toContain("Edit stage");
    expect(html).toContain("Contract is $250,000.00 ex GST.");
    expect(html).toContain("$51,200.00"); // 20% of 250,000 + 1,200
    expect(html).toContain("Less 5% retention ($2,560.00)");
    expect(html).toContain("$48,640.00 would be invoiced");
    expect(html).toContain("Save changes");
  });

  it("says a % can't be worked out yet when the job has no contract value", () => {
    const html = render(createElement(StageEditor, {
      jobId: "tower", contractCents: null, jobRetentionBp: 0, stage: stage(), onClose: noop, onSaved: noop, onStale: noop,
    }));
    expect(html).toContain("no contract value yet");
    expect(html).toContain("The amount will fill in once the job has a contract value.");
  });
});

describe("buildStageInput", () => {
  const form = (over: Partial<Parameters<typeof buildStageInput>[0]> = {}) => ({
    title: "Deposit", basis: "amount" as const, amount: "12000", percent: "", lines: [], plannedDate: "", retentionBp: null, note: null, ...over,
  });

  it("builds a dollar stage in integer cents", () => {
    expect(buildStageInput(form({ amount: "12,000.50" }))).toEqual({
      ok: true,
      input: { title: "Deposit", basis: "amount", amountCents: 12_000_50, percentBp: null, extraLines: [], retentionBp: null, plannedDate: null, note: null },
    });
  });

  it("builds a % stage in basis points and drops the unused amount", () => {
    const r = buildStageInput(form({ basis: "percent", percent: "12.5", amount: "999" }));
    expect(r).toMatchObject({ ok: true, input: { basis: "percent", percentBp: 1250, amountCents: null } });
  });

  it("keeps filled extra lines, ignores an untouched blank row", () => {
    const r = buildStageInput(form({ lines: [{ description: " Variation 3 ", amount: "1200" }, { description: "", amount: "" }] }));
    expect(r).toMatchObject({ ok: true, input: { extraLines: [{ description: "Variation 3", amountCents: 1_200_00 }] } });
  });

  it("carries a stage's existing retention override and note through untouched", () => {
    const r = buildStageInput(form({ retentionBp: 250, note: "office note", plannedDate: "2026-12-01" }));
    expect(r).toMatchObject({ ok: true, input: { retentionBp: 250, note: "office note", plannedDate: "2026-12-01" } });
  });

  it("names the field that is wrong instead of guessing", () => {
    expect(buildStageInput(form({ title: "   " }))).toMatchObject({ ok: false, field: "title" });
    expect(buildStageInput(form({ amount: "" }))).toMatchObject({ ok: false, field: "amount" });
    expect(buildStageInput(form({ amount: "12.345" }))).toMatchObject({ ok: false, field: "amount" });
    expect(buildStageInput(form({ amount: "-5" }))).toMatchObject({ ok: false, field: "amount" });
    expect(buildStageInput(form({ basis: "percent", percent: "0" }))).toMatchObject({ ok: false, field: "percent" });
    expect(buildStageInput(form({ basis: "percent", percent: "101" }))).toMatchObject({ ok: false, field: "percent" });
    expect(buildStageInput(form({ lines: [{ description: "", amount: "50" }] }))).toMatchObject({ ok: false, field: "lines" });
    expect(buildStageInput(form({ lines: [{ description: "Var", amount: "abc" }] }))).toMatchObject({ ok: false, field: "lines" });
    expect(buildStageInput(form({ plannedDate: "1/12/2026" }))).toMatchObject({ ok: false, field: "plannedDate" });
  });
});
