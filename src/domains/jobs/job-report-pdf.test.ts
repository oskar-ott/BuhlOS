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
