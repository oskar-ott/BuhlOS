import { describe, expect, it } from "vitest";
import type { ProofStatusResult } from "@/server/job-control/status";
import { proofStatusHeadline, summariseProofStatus } from "./jobControlStatusClient";

function compiled(over: Partial<Extract<ProofStatusResult, { status: "compiled" }>> = {}): ProofStatusResult {
  return {
    ok: true,
    jobId: "job_1",
    status: "compiled",
    revision: "rev_1",
    sourceHash: "sh",
    sourceReconciliationHash: "srh",
    sourceStructureHash: "ssh",
    generatedAt: null,
    confirmedAt: null,
    confirmedBy: null,
    gapCount: 0,
    workPackageCount: 1,
    requiredProofTotal: 3,
    neededCount: 1,
    metCount: 2,
    evidenceLinkCount: 2,
    workPackages: [],
    danglingRefs: [],
    ...over,
  };
}

describe("summariseProofStatus", () => {
  it("returns the compiled counts for a compiled artifact", () => {
    expect(summariseProofStatus(compiled())).toEqual({
      compiled: true,
      workPackageCount: 1,
      requiredProofTotal: 3,
      neededCount: 1,
      metCount: 2,
      evidenceLinkCount: 2,
    });
  });

  it("collapses missing / unreadable / load-error to zeros (never a fabricated count)", () => {
    const zero = {
      compiled: false,
      workPackageCount: 0,
      requiredProofTotal: 0,
      neededCount: 0,
      metCount: 0,
      evidenceLinkCount: 0,
    };
    expect(summariseProofStatus({ ok: true, jobId: "j", status: "missing" })).toEqual(zero);
    expect(summariseProofStatus({ ok: true, jobId: "j", status: "unreadable" })).toEqual(zero);
    expect(summariseProofStatus({ ok: false, error: "x" })).toEqual(zero);
  });
});

describe("proofStatusHeadline", () => {
  it("is plain copy for each state", () => {
    expect(proofStatusHeadline({ ok: false, error: "x" })).toMatch(/Could not load/i);
    expect(proofStatusHeadline({ ok: true, jobId: "j", status: "missing" })).toMatch(
      /No compiled proof status yet/i,
    );
    expect(proofStatusHeadline({ ok: true, jobId: "j", status: "unreadable" })).toMatch(/unreadable/i);
    expect(proofStatusHeadline(compiled())).toMatch(/2 of 3 required proofs captured/i);
  });

  it("says 'no required proof items' for a compiled artifact with none", () => {
    expect(proofStatusHeadline(compiled({ requiredProofTotal: 0, metCount: 0, neededCount: 0 }))).toMatch(
      /no required proof items/i,
    );
  });
});
