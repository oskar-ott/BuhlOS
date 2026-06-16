import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { CompiledProofStatus } from "./CompiledProofStatus";
import type { ProofStatusResult } from "@/server/job-control/status";

function render(status: ProofStatusResult): string {
  return renderToString(createElement(CompiledProofStatus, { status })).replace(/<!-- -->/g, "");
}

const COMPILED: ProofStatusResult = {
  ok: true,
  jobId: "job_1",
  status: "compiled",
  revision: "rev_abc",
  sourceHash: "srchash",
  sourceReconciliationHash: "rechash",
  sourceStructureHash: "structhash",
  generatedAt: "2026-06-15T00:00:00.000Z",
  confirmedAt: "2026-06-16T00:00:00.000Z",
  confirmedBy: "Boss",
  gapCount: 0,
  workPackageCount: 1,
  requiredProofTotal: 2,
  neededCount: 1,
  metCount: 1,
  evidenceLinkCount: 1,
  workPackages: [
    {
      id: "wp_1",
      title: "East Gym",
      scopeClauseIds: ["sw_zip"],
      requiredEvidence: [
        {
          id: "re_met",
          label: "Photo of completed ZIP tap",
          kind: "photo",
          note: null,
          status: "met",
          evidenceLinks: [
            { evidenceId: "ev_123", observationId: null, linkedAt: "2026-06-16T01:00:00.000Z", linkedBy: "Sparky" },
          ],
        },
        {
          id: "re_needed",
          label: "Circuit test results",
          kind: "test_result",
          note: "before energising",
          status: "needed",
          evidenceLinks: [],
        },
      ],
    },
  ],
};

describe("CompiledProofStatus", () => {
  it("renders the no-artifact state plainly", () => {
    const html = render({ ok: true, jobId: "job_1", status: "missing" });
    expect(html).toContain("Compiled proof status");
    expect(html).toContain("No compiled proof status yet");
  });

  it("renders the unreadable state", () => {
    expect(render({ ok: true, jobId: "job_1", status: "unreadable" })).toContain("unreadable");
  });

  it("renders the load-error state", () => {
    expect(render({ ok: false, error: "x" })).toContain("Could not load compiled proof status.");
  });

  it("renders the work package, needed + met proofs with plain kind labels", () => {
    const html = render(COMPILED);
    expect(html).toContain("East Gym"); // work package title
    expect(html).toContain("Photo of completed ZIP tap");
    expect(html).toContain("Circuit test results");
    expect(html).toContain("Met");
    expect(html).toContain("Needed");
    expect(html).toContain("Photo"); // kind label, not raw "photo" enum as a primary label
    expect(html).toContain("Test result");
    expect(html).toContain("before energising");
    expect(html).toContain("1 of 2 required proofs captured");
  });

  it("renders the distinct summary-count row (not just the per-requirement badges)", () => {
    const html = render(COMPILED);
    expect(html).toContain("Work packages: 1");
    expect(html).toContain("Required proofs: 2");
    expect(html).toContain("Met: 1");
    expect(html).toContain("Needed: 1");
  });

  it("shows captured-evidence provenance for a met proof", () => {
    const html = render(COMPILED);
    expect(html).toContain("Evidence captured");
    expect(html).toContain("Sparky");
  });

  it("renders a met proof with no timestamp/author cleanly (no 'by null', no trailing separator)", () => {
    const nullProv: ProofStatusResult = {
      ...COMPILED,
      workPackages: [
        {
          ...COMPILED.workPackages[0]!,
          requiredEvidence: [
            {
              id: "re_met",
              label: "Photo of board",
              kind: "photo",
              note: null,
              status: "met",
              evidenceLinks: [{ evidenceId: "ev_x", observationId: null, linkedAt: null, linkedBy: null }],
            },
          ],
        },
      ],
    };
    const html = render(nullProv);
    expect(html).toContain("Evidence captured");
    expect(html).not.toContain("by null");
    expect(html).not.toContain("· null");
  });

  it("renders the compile-gap footer only when there are gaps", () => {
    expect(render(COMPILED)).not.toContain("compile gap");
    expect(render({ ...COMPILED, gapCount: 2 })).toContain("2 compile gap(s)");
  });

  it("renders revision/compile metadata", () => {
    const html = render(COMPILED);
    expect(html).toContain("rev_abc");
    expect(html).toContain("linked evidence");
  });

  it("keeps raw ids (work package / requirement) out of the primary UI — only in the dev foldout", () => {
    const html = render(COMPILED);
    expect(html).toContain("Developer details");
    // the primary list shows titles/labels, not the wp_/re_ ids as visible text
    expect(html).not.toMatch(/>\s*wp_1\s*</);
    expect(html).not.toMatch(/>\s*re_met\s*</);
    // ids DO appear inside the foldout's JSON (acceptable — secondary)
    expect(html).toContain("wp_1");
  });

  it("handles a compiled artifact with no required proof items", () => {
    const html = render({ ...COMPILED, requiredProofTotal: 0, neededCount: 0, metCount: 0, workPackages: [] });
    expect(html).toContain("no required proof items are present");
  });
});
