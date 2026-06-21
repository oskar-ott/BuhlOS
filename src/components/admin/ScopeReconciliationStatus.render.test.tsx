import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ScopeReconciliationStatus } from "./ScopeReconciliationStatus";
import type { ScopeReconciliationView } from "@/server/job-control/reconciliation-read";

function render(view: ScopeReconciliationView): string {
  return renderToString(createElement(ScopeReconciliationStatus, { view })).replace(/<!-- -->/g, "");
}

const RECONCILED: ScopeReconciliationView = {
  ok: true,
  jobId: "job-1",
  status: "reconciled",
  rag: "red",
  quoteId: "qv2_abc",
  confirmedBy: "Boss",
  confirmedAt: "2026-06-20T01:00:00.000Z",
  updatedAt: "2026-06-20T01:00:00.000Z",
  counts: { clauses: 3, classified: 2, unclassified: 1, openFindings: 2, redFindings: 1, amberFindings: 1 },
  clauses: [
    { clauseId: "c1", classification: "priced", warningText: null, note: null, boqLineCount: 1, deliveredByCount: 0, requiredEvidenceCount: 0 },
    { clauseId: "c2", classification: "excluded", warningText: null, note: "disposal owed", boqLineCount: 0, deliveredByCount: 0, requiredEvidenceCount: 0 },
    { clauseId: "c3", classification: "unclear", warningText: null, note: null, boqLineCount: 0, deliveredByCount: 0, requiredEvidenceCount: 0 },
    { clauseId: "c4", classification: "by_others", warningText: "A/V hardware by others — cabling only", note: null, boqLineCount: 0, deliveredByCount: 0, requiredEvidenceCount: 0 },
  ],
  findings: [
    { key: "k1", kind: "excluded_with_obligation", severity: "red", clauseId: "c2", message: "Clause c2 is excluded but still carries an obligation" },
    { key: "k2", kind: "clause_unpriced_unclassified", severity: "amber", clauseId: "c3", message: "Scope clause c3 is not yet classified" },
  ],
};

describe("ScopeReconciliationStatus", () => {
  it("shows an honest 'no reconciliation yet' state pointing at Job control", () => {
    const html = render({ ok: true, jobId: "job-1", status: "missing" });
    expect(html).toContain("No reconciliation yet");
    expect(html).toContain("Job control");
  });

  it("surfaces an unreadable artifact rather than rendering empty", () => {
    const html = render({ ok: true, jobId: "job-1", status: "unreadable" });
    expect(html).toContain("Couldn");
    expect(html).toContain("Re-confirm");
  });

  it("renders the RAG status, counts, findings and the clause table", () => {
    const html = render(RECONCILED);
    expect(html).toContain("Conflicts to resolve"); // red RAG label
    expect(html).toContain("2/3 clauses classified");
    expect(html).toContain("1 red");
    expect(html).toContain("excluded but still carries an obligation");
    expect(html).toContain("Excluded");
    expect(html).toContain("By others");
    expect(html).toContain("Not yet classified"); // the unclear clause
    expect(html).toContain("A/V hardware by others"); // warning text rendered
    expect(html).toContain("quote qv2_abc");
  });

  it("renders a green, finding-free reconciliation cleanly", () => {
    const green: ScopeReconciliationView = {
      ...RECONCILED,
      rag: "green",
      counts: { clauses: 2, classified: 2, unclassified: 0, openFindings: 0, redFindings: 0, amberFindings: 0 },
      findings: [],
    };
    const html = render(green);
    expect(html).toContain("Reconciled");
    expect(html).toContain("No open findings");
  });
});
