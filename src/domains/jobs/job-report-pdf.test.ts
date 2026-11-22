import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/** The job cost report composer: pure, paginated, never invents a figure. */
const requireFromHere = createRequire(import.meta.url);
const { composeJobReportPdf, money } = requireFromHere("../../../api/_lib/job-report-pdf.js");
const { extractPdfText } = requireFromHere("../../../api/_lib/invoices/pdf-text.js");

const base = {
  job: { id: "birdwood", name: "Birdwood", code: "IV3232", siteAddress: "17 Birdwood Ave", status: "active" },
  generatedAt: "2026-09-28",
  money: { contractValueCents: null, labourCostCents: 0, materialCostCents: 0, marginCents: null, marginPct: null },
  labour: { hoursTotal: 0, pendingHours: 0, unratedWorkers: [], workers: [], days: [] },
  materials: { invoicesShown: false, ledgerShown: false, categories: [], invoices: [], ledger: [], awaitingCount: 0 },
};

describe("composeJobReportPdf", () => {
  it("an empty job says so instead of printing zeros", async () => {
    const { text } = await extractPdfText(Buffer.from(await composeJobReportPdf(base)));
    expect(text).toContain("IV3232 Birdwood");
    expect(text).toContain("No approved hours on this job yet");
    expect(text).toContain("Materials are not tracked on this job yet");
    expect(text).toContain("needs a contract value");
  });
  it("prints the job's client when set (owner pull 2026-10-03), and nothing when not", async () => {
    const withClient = await extractPdfText(
      Buffer.from(await composeJobReportPdf({ ...base, job: { ...base.job, clientName: "Hutchinson Builders" } }))
    );
    expect(withClient.text).toContain("Client: Hutchinson Builders");
    const without = await extractPdfText(Buffer.from(await composeJobReportPdf(base)));
    expect(without.text).not.toContain("Client:");
  });
  it("a long job paginates with the header repeated and a page x of y footer", async () => {
    const days = Array.from({ length: 150 }, (_, i) => ({ date: `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, "0")}`, name: "Dylan Sinclair", hours: 7.6, costCents: 39520 }));
    const bytes = await composeJobReportPdf({ ...base, labour: { hoursTotal: 1140, pendingHours: 0, unratedWorkers: [], workers: [{ name: "Dylan Sinclair", days: 150, hours: 1140, costCents: 5928000 }], days } });
    const { text, pageCount } = await extractPdfText(Buffer.from(bytes));
    expect(pageCount).toBeGreaterThanOrEqual(3);
    expect(text).toContain(`page 1 of ${pageCount}`);
    expect(text).toContain("Labour day by day (continued)");
  });
  it("hours with no cost rate are 'not costed', never a $0.00 labour bill", async () => {
    const bytes = await composeJobReportPdf({ ...base, labour: { hoursTotal: 137.2, pendingHours: 0, unratedWorkers: ["Dylan Sinclair"], workers: [{ name: "Dylan Sinclair", days: 8, hours: 137.2, costCents: null }], days: [{ date: "2026-09-15", name: "Dylan Sinclair", hours: 7.6, costCents: null }] } });
    const { text } = await extractPdfText(Buffer.from(bytes));
    expect(text).toContain("137.2h approved - not costed");
    expect(text).toContain("no rates set");
    expect(text).not.toContain("$0.00");
  });
  it("money formatting: cents, thousands, negatives, nothing", () => {
    expect(money(265655)).toBe("$2,656.55");
    expect(money(-15400)).toBe("-$154.00");
    expect(money(null)).toBe("-");
  });
});

describe("composeJobReportPdf — Invoicing (customer stage invoices, #1151)", () => {
  const textOf = async (invoicing: unknown) => (await extractPdfText(Buffer.from(await composeJobReportPdf({ ...base, invoicing })))).text as string;
  const totals = {
    unavailable: false, plannedCount: 1, invoicedCents: 30_000_00, draftedCents: 5_000_00, paidIncGstCents: 11_000_00, dueIncGstCents: 22_000_00,
    retentionHeldCents: 1_500_00, stillToInvoiceCents: 85_000_00, overdueCount: 1, asOf: "2026-11-30T23:30:00.000Z",
  };
  const invoices = [
    { invoiceNumber: "IV3232-1", title: "Deposit", invoiceDate: "2026-06-01", dueDate: "2026-07-01", status: "paid", subtotalCents: 10_000_00, amountPaidCents: 11_000_00, amountDueCents: 0, fullyPaidOn: "2026-06-20" },
    { invoiceNumber: "IV3232-2", title: "Rough-in", invoiceDate: "2026-07-01", dueDate: "2026-07-31", status: "overdue", subtotalCents: 20_000_00, amountPaidCents: 0, amountDueCents: 22_000_00, fullyPaidOn: null },
    { invoiceNumber: "IV3232-3", title: "Fit-off", invoiceDate: "2026-08-01", dueDate: "2026-08-31", status: "draft_in_xero", subtotalCents: 5_000_00, amountPaidCents: 0, amountDueCents: 5_500_00, fullyPaidOn: null },
    { invoiceNumber: "IV3232-4", title: "Raised in error", invoiceDate: "2026-08-02", dueDate: "2026-09-01", status: "voided", subtotalCents: 9_999_00, amountPaidCents: 0, amountDueCents: 0, fullyPaidOn: null },
  ];

  it("has no Invoicing section at all while the feature is off", async () => {
    expect(await textOf(null)).not.toContain("Invoicing");
    expect(await textOf(undefined)).not.toContain("Invoicing");
  });

  it("lists every sent invoice with Xero's figures and status, then the totals", async () => {
    const text = await textOf({ ...totals, invoices });
    expect(text).toContain("Invoicing");
    expect(text).toContain("Amounts and status are as Xero reports them. Subtotals are ex GST; paid and owing include GST.");
    expect(text).toContain("IV3232-1");
    expect(text).toContain("Paid, Sat 20/06/2026");
    expect(text).toContain("Overdue, due Fri 31/07/2026");
    expect(text).toContain("Draft in Xero");
    expect(text).toContain("Voided in Xero");
    expect(text).toContain("Approved in Xero (ex GST)");
    expect(text).toContain("$30,000.00");
    expect(text).toContain("Still a draft in Xero (ex GST)");
    expect(text).toContain("Paid (inc GST)");
    expect(text).toContain("Owing (inc GST)");
    expect(text).toContain("Retention held (ex GST)");
    expect(text).toContain("$1,500.00");
    expect(text).toContain("Still to invoice against the contract (ex GST)");
    expect(text).toContain("$85,000.00");
    expect(text).toContain("Last checked with Xero 01/12/2026, 10:30 am (Sydney time).");
  });

  it("nothing sent yet says so, and counts what is planned", async () => {
    expect(await textOf({ ...totals, invoices: [], plannedCount: 2 })).toContain("No stage invoice has been sent to Xero for this job yet. 2 planned.");
    expect(await textOf({ ...totals, invoices: [], plannedCount: 0 })).toContain("No stage invoices on this job yet.");
  });

  it("unreadable records are named — never printed as nothing invoiced", async () => {
    const text = await textOf({ unavailable: true });
    expect(text).toContain("The invoice records could not be read when this report was made");
    expect(text).toContain("That is not the same as nothing invoiced.");
    expect(text).not.toContain("Approved in Xero");
  });

  it("a long invoice list paginates with its header repeated", async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ ...invoices[0]!, invoiceNumber: `IV3232-${i + 1}` }));
    const { text, pageCount } = await extractPdfText(Buffer.from(await composeJobReportPdf({ ...base, invoicing: { ...totals, invoices: many } })));
    expect(pageCount).toBeGreaterThanOrEqual(2);
    expect(text).toContain("Invoicing (continued)");
    expect(text).toContain("IV3232-80");
  });
});
