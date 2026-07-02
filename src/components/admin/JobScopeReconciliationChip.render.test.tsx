import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobScopeReconciliationChip } from "./JobScopeReconciliationChip";
import type { ScopeReconciliationView } from "@/server/job-control/reconciliation-read";

function render(view: ScopeReconciliationView | null): string {
  return renderToString(
    createElement(JobScopeReconciliationChip, { jobId: "job-1", view }),
  ).replace(/<!-- -->/g, "");
}

function reconciled(over: Partial<Extract<ScopeReconciliationView, { status: "reconciled" }>>) {
  const base: Extract<ScopeReconciliationView, { status: "reconciled" }> = {
    ok: true,
    jobId: "job-1",
    status: "reconciled",
    rag: "green",
    quoteId: null,
    confirmedBy: "Boss",
    confirmedAt: "2026-06-20T01:00:00.000Z",
    updatedAt: "2026-06-20T01:00:00.000Z",
    counts: { clauses: 4, classified: 4, unclassified: 0, openFindings: 0, redFindings: 0, amberFindings: 0 },
    clauses: [],
    findings: [],
    resolutions: [],
    sourceHash: "h1",
  };
  return { ...base, ...over };
}

describe("JobScopeReconciliationChip (#366 AC3 — the hub shows the state)", () => {
  it("renders NOTHING when no reconciliation exists (no fake state)", () => {
    expect(render(null)).toBe("");
    expect(render({ ok: true, jobId: "job-1", status: "missing" })).toBe("");
    expect(render({ ok: true, jobId: "job-1", status: "unreadable" })).toBe("");
  });

  it("red: names the conflicts to resolve and links into the builder's Scope section", () => {
    const html = render(
      reconciled({
        rag: "red",
        counts: { clauses: 4, classified: 4, unclassified: 0, openFindings: 3, redFindings: 2, amberFindings: 1 },
      }),
    );
    expect(html).toContain("2 conflicts to resolve");
    expect(html).toContain("/v2/jobs/job-1/builder#scope");
    expect(html).toContain("Review in builder");
  });

  it("amber with unclassified clauses: says how many scope lines still need classifying", () => {
    const html = render(
      reconciled({
        rag: "amber",
        counts: { clauses: 4, classified: 3, unclassified: 1, openFindings: 1, redFindings: 0, amberFindings: 1 },
      }),
    );
    expect(html).toContain("1 scope line not yet classified");
  });

  it("amber with all clauses classified: falls back to the open-finding count", () => {
    const html = render(
      reconciled({
        rag: "amber",
        counts: { clauses: 4, classified: 4, unclassified: 0, openFindings: 2, redFindings: 0, amberFindings: 2 },
      }),
    );
    expect(html).toContain("2 findings to check");
  });

  it("green: says the scope is reconciled with the classified count", () => {
    const html = render(reconciled({}));
    expect(html).toContain("Scope reconciled");
    expect(html).toContain("4/4 clauses classified");
  });
});
