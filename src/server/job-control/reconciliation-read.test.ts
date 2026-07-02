import { describe, expect, it } from "vitest";
import {
  runScopeReconciliationView,
  type ReconciliationReadDeps,
} from "./reconciliation-read";

function depsReturning(raw: unknown): ReconciliationReadDeps {
  return { readRaw: async () => raw };
}

/** A valid persisted envelope: 3 clauses (priced / excluded / unclear), two
 *  findings (one red, one amber). Built as raw JSON so the read module's
 *  safeParse is exercised. */
function fixture() {
  return {
    jobId: "job-1",
    reconciliation: {
      jobId: "job-1",
      quoteId: "qv2_abc",
      clauseClassifications: [
        {
          clauseId: "c1",
          classification: "priced",
          boqLineRefs: [{ quoteId: "qv2_abc", sectionId: "s1", lineId: "l1" }],
        },
        { clauseId: "c2", classification: "excluded", note: "disposal owed on site" },
        { clauseId: "c3", classification: "unclear" },
      ],
      boqClassifications: [],
      resolutions: [
        {
          findingKey: "alternate_in_base_total:q1|s1|l9",
          action: "accepted",
          reason: "PL3 pendants confirmed with the client",
          by: "Boss",
          at: "2026-06-19T23:00:00.000Z",
        },
      ],
      updatedAt: "2026-06-20T00:00:00.000Z",
    },
    status: "red",
    warnings: [
      {
        key: "excluded_with_obligation:c2",
        kind: "excluded_with_obligation",
        severity: "red",
        clauseId: "c2",
        message: "Clause c2 is excluded but still carries an obligation",
      },
      {
        key: "clause_unpriced_unclassified:c3",
        kind: "clause_unpriced_unclassified",
        severity: "amber",
        clauseId: "c3",
        message: "Scope clause c3 is not yet classified",
      },
    ],
    sourceHash: "abc123",
    confirmedBy: "Boss",
    confirmedAt: "2026-06-20T01:00:00.000Z",
    generatedAt: "2026-06-19T00:00:00.000Z",
    updatedAt: "2026-06-20T01:00:00.000Z",
  };
}

describe("runScopeReconciliationView", () => {
  it("returns 'missing' when no artifact exists", async () => {
    const view = await runScopeReconciliationView(depsReturning(null), "job-1");
    expect(view.status).toBe("missing");
  });

  it("returns 'unreadable' when the artifact fails to parse", async () => {
    const view = await runScopeReconciliationView(depsReturning({ not: "a reconciliation" }), "job-1");
    expect(view.status).toBe("unreadable");
  });

  it("returns 'unreadable' when the read throws (never crashes the page)", async () => {
    const deps: ReconciliationReadDeps = {
      readRaw: async () => {
        throw new Error("blob down");
      },
    };
    const view = await runScopeReconciliationView(deps, "job-1");
    expect(view.status).toBe("unreadable");
  });

  it("shapes the confirmed reconciliation: rag, counts, clauses, findings", async () => {
    const view = await runScopeReconciliationView(depsReturning(fixture()), "job-1");
    if (view.status !== "reconciled") throw new Error("expected reconciled");
    expect(view.rag).toBe("red");
    expect(view.quoteId).toBe("qv2_abc");
    expect(view.confirmedBy).toBe("Boss");
    expect(view.counts).toEqual({
      clauses: 3,
      classified: 2, // priced + excluded; unclear is not classified
      unclassified: 1,
      openFindings: 2,
      redFindings: 1,
      amberFindings: 1,
    });
    expect(view.clauses.find((c) => c.clauseId === "c1")?.boqLineCount).toBe(1);
    expect(view.clauses.find((c) => c.clauseId === "c3")?.classification).toBe("unclear");
    expect(view.findings.map((f) => f.kind)).toContain("excluded_with_obligation");
  });

  it("exposes the recorded resolutions (who/when/why) and the confirmed sourceHash", async () => {
    const view = await runScopeReconciliationView(depsReturning(fixture()), "job-1");
    if (view.status !== "reconciled") throw new Error("expected reconciled");
    expect(view.sourceHash).toBe("abc123"); // the interactive write's stale guard
    expect(view.resolutions).toEqual([
      {
        findingKey: "alternate_in_base_total:q1|s1|l9",
        action: "accepted",
        reason: "PL3 pendants confirmed with the client",
        by: "Boss",
        at: "2026-06-19T23:00:00.000Z",
      },
    ]);
  });
});
