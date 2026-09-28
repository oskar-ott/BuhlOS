import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AutoBookingShadowCard, ShadowReportView } from "./AutoBookingShadowCard";
import type { ShadowReport } from "@/domains/invoices/schema";

/**
 * Task F (2026-09-27): the shadow report's render contract — unresolved is
 * shown as its own number (never folded into right/wrong), the gate is a
 * checklist, every disagreement links to its invoice, and the card starts
 * collapsed with no fabricated figures.
 */
const REPORT: ShadowReport = {
  period: { from: "2026-07-01", to: "2026-09-28" },
  generatedAt: "2026-09-28T00:00:00.000Z",
  days: 90,
  autoBookingEnabled: false,
  invoicesInPeriod: 7,
  sampleSize: 5,
  neverEvaluated: 1,
  setAside: 1,
  legacyVerdicts: 2,
  unresolved: 1,
  wouldHaveBooked: { count: 4, agreed: 1, falsePositives: 2, unresolved: 1, autoBookedStands: 0, autoBookedThenReversed: 0, falsePositiveReasons: { job_changed: 1, excluded_by_person: 1 } },
  wouldHaveWaited: { count: 1, correct: 0, falseNegatives: 1, unresolved: 0, falseNegativeReasons: { supplier_trusted: 1 } },
  agreement: { job: { agree: 2, differ: 1, unknown: 1 }, supplier: { agree: 3, differ: 0, unknown: 1 }, figures: { agree: 3, differ: 0, unknown: 1 } },
  humanExclusions: 1,
  humanJobChanges: 1,
  disagreements: [
    { invoiceId: "inv-wrongjob", supplierName: "Sparky Supplies", supplierInvoiceNumber: "SS-2", kind: "false_positive", reasons: ["job_changed"], verdictJob: "birdwood", finalJob: "kent-st" },
    { invoiceId: "inv-fn", supplierName: "Sparky Supplies", supplierInvoiceNumber: "SS-3", kind: "false_negative", reasons: ["supplier_trusted"], verdictJob: "birdwood", finalJob: "birdwood" },
  ],
  bySupplier: [{ supplierKey: "sparky", supplierName: "Sparky Supplies", sample: 5, wouldHaveBooked: 4, agreed: 1, falsePositives: 2, falseNegatives: 1, unresolved: 1, autoBooked: 0, autoBookedThenReversed: 0 }],
  gate: {
    pass: false,
    checks: [
      { code: "sample_size", ok: false, detail: "5 evaluated (need 30)" },
      { code: "zero_wrong_job", ok: false, detail: "1 would-have-booked with a different final job" },
      { code: "zero_wrong_total", ok: true, detail: "0 with different figures" },
    ],
    suppliersReady: [],
    thresholds: { minSample: 30 },
  },
};

describe("ShadowReportView — render contract", () => {
  it("shows unresolved as its own honest number, the gate as a checklist, and links every disagreement", () => {
    // React separates adjacent text nodes with `<!-- -->`; strip them so the copy reads whole.
    const html = renderToString(createElement(ShadowReportView, { report: REPORT })).replace(/<!--\s*-->/g, "");
    expect(html).toContain("No human outcome yet");
    expect(html).toContain("never counted as right or wrong");
    expect(html).toContain("automatic booking is");
    expect(html).toContain("OFF");
    expect(html).toContain("Release gate: not yet");
    expect(html).toContain("Enough evaluated invoices");
    expect(html).toContain("5 evaluated (need 30)");
    expect(html).toContain('href="/invoices/inv-wrongjob"');
    expect(html).toContain('href="/invoices/inv-fn"');
    expect(html).toContain("different job");
    expect(html).toContain("2 verdicts predate the snapshot");
    expect(html).toContain("Sparky Supplies");
  });

  it("the card starts collapsed: explanation only, no figures, no fetch", () => {
    const html = renderToString(createElement(AutoBookingShadowCard));
    expect(html).toContain("Automatic booking — shadow report");
    expect(html).toContain("It changes nothing.");
    expect(html).not.toContain("Release gate");
    expect(html).not.toContain("shadow-report-skeleton");
  });
});
