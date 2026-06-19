import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilTaskScopeContext } from "./PhilTaskScopeContext";
import type { PhilTaskContext } from "@/domains/job-control/task-context";

/**
 * The component renders ONLY from a PhilTaskContext the model already built —
 * no recompute, no data inspection. These tests pin: every section renders from
 * real fields; an empty context renders NOTHING (zero regression); and the
 * required-evidence tick is driven by the model's `met` flag, never a count.
 * renderToString + substring assertions, matching the repo's other Phil render
 * tests.
 */
function render(context: PhilTaskContext): string {
  return renderToString(createElement(PhilTaskScopeContext, { context })).replace(/<!-- -->/g, "");
}

function renderWithProof(
  context: PhilTaskContext,
  opts: {
    onCaptureProof?: (t: { workPackageId: string; requiredEvidenceId: string }) => void;
    canCaptureProof?: boolean;
    proofActionState?: Record<string, "saving" | "saved_not_linked" | "stale" | "error">;
  },
): string {
  return renderToString(
    createElement(PhilTaskScopeContext, {
      context,
      onCaptureProof: opts.onCaptureProof,
      canCaptureProof: opts.canCaptureProof,
      proofActionState: opts.proofActionState,
    }),
  ).replace(/<!-- -->/g, "");
}

function renderWithJob(context: PhilTaskContext, jobId?: string): string {
  return renderToString(
    createElement(PhilTaskScopeContext, { context, jobId }),
  ).replace(/<!-- -->/g, "");
}

const FULL: PhilTaskContext = {
  workPackageId: "wp_1",
  scopeNote: "Run a dedicated 20A circuit to the ZIP tap.",
  governingDocs: [{ documentId: "doc1", label: "E-101 Power layout" }],
  materials: [{ label: "20A DGPO", qty: 12, unit: "ea", boqLineRef: null }],
  requiredEvidence: [
    { id: "re1", label: "Photo of the board", kind: "photo", note: null, met: true },
    {
      id: "re2",
      label: "Test results",
      kind: "test_result",
      note: "before energising",
      met: false,
    },
  ],
  warnings: [
    {
      id: "w1",
      kind: "variation_trigger",
      text: "PL3 pendants — confirm before install",
      scopeClauseId: null,
    },
    {
      id: "w2",
      kind: "by_others",
      text: "A/V hardware by others: cabling only",
      scopeClauseId: null,
    },
  ],
  isEmpty: false,
};

const EMPTY: PhilTaskContext = {
  workPackageId: null,
  scopeNote: null,
  governingDocs: [],
  materials: [],
  requiredEvidence: [],
  warnings: [],
  isEmpty: true,
};

describe("PhilTaskScopeContext", () => {
  it("renders scope, drawing, materials, evidence and warnings from the model", () => {
    const html = render(FULL);
    expect(html).toContain("Task context");
    expect(html).toContain("Run a dedicated 20A circuit to the ZIP tap.");
    expect(html).toContain("E-101 Power layout");
    expect(html).toContain("20A DGPO");
    expect(html).toContain("Photo of the board");
    expect(html).toContain("Test results");
    expect(html).toContain("before energising");
    // Variation trigger leads as a stop notice; other traps render too.
    expect(html).toContain("Stop — flag a variation first");
    expect(html).toContain("PL3 pendants — confirm before install");
    expect(html).toContain("By others");
    expect(html).toContain("A/V hardware by others: cabling only");
  });

  it("renders NOTHING for an empty context (zero regression — no placeholder)", () => {
    const html = render(EMPTY);
    expect(html).toBe("");
    expect(html).not.toContain("Task context");
    expect(html).not.toContain("No task context");
  });

  it("ticks required evidence from the model's `met` flag, not a photo count", () => {
    // Exactly one item is met in FULL → exactly one 'done' marker.
    const html = render(FULL);
    expect((html.match(/· done/g) ?? []).length).toBe(1);
    expect(html).toContain("line-through");

    // Flip ONLY the met flag (same labels, same everything else): the tick must
    // follow the model, proving it is never derived from the row itself.
    const allMet: PhilTaskContext = {
      ...FULL,
      requiredEvidence: FULL.requiredEvidence.map((e) => ({ ...e, met: true })),
    };
    expect((render(allMet).match(/· done/g) ?? []).length).toBe(2);

    const noneMet: PhilTaskContext = {
      ...FULL,
      requiredEvidence: FULL.requiredEvidence.map((e) => ({ ...e, met: false })),
    };
    expect(render(noneMet)).not.toContain("· done");
  });

  it("is an inline disclosure, not a new top-level job-screen section", () => {
    const html = render(FULL);
    // Anti-creep (#132): no <section>, no #phil-job-* anchor, no <h2> heading.
    expect(html).not.toContain("<section");
    expect(html).not.toContain('id="phil-job');
    expect(html).not.toContain("<h2");
    expect(html).toContain("<details");
  });

  it("renders NO capture affordance without a handler/revision (today's read-only default)", () => {
    expect(render(FULL)).not.toContain("Capture proof");
  });

  it("renders a 'Capture proof' action ONLY for an unmet requirement when handler + revision + workPackage exist", () => {
    // FULL has re1 met, re2 unmet → exactly one capture action (for re2).
    const html = renderWithProof(FULL, { onCaptureProof: () => {}, canCaptureProof: true });
    expect((html.match(/Capture proof/g) ?? []).length).toBe(1);
  });

  it("hides the capture action when no revision is available (canCaptureProof false)", () => {
    expect(renderWithProof(FULL, { onCaptureProof: () => {}, canCaptureProof: false })).not.toContain(
      "Capture proof",
    );
  });

  it("hides the capture action when the task belongs to no work package (workPackageId null)", () => {
    const noPkg: PhilTaskContext = {
      ...FULL,
      workPackageId: null,
      // keep it non-empty so the disclosure still renders
      scopeNote: "Some note",
    };
    expect(renderWithProof(noPkg, { onCaptureProof: () => {}, canCaptureProof: true })).not.toContain(
      "Capture proof",
    );
  });

  it("shows a plain status message for a stale link attempt", () => {
    const html = renderWithProof(FULL, {
      onCaptureProof: () => {},
      canCaptureProof: true,
      proofActionState: { re2: "stale" },
    });
    expect(html).toContain("Refresh and try again");
  });

  it("shows a 'Saving…' button while a link is in flight", () => {
    const html = renderWithProof(FULL, {
      onCaptureProof: () => {},
      canCaptureProof: true,
      proofActionState: { re2: "saving" },
    });
    expect(html).toContain("Saving…");
  });

  it("links a governing drawing into the Phil plans viewer when jobId is provided (#368)", () => {
    const html = renderWithJob(FULL, "job-7");
    // The named sheet renders inside an anchor to THIS job's plans viewer.
    expect(html).toContain('href="/phil/jobs/job-7/plans"');
    expect(html).toContain("E-101 Power layout");
    // It's a real anchor wrapping the label, not plain text.
    expect(html).toMatch(/<a[^>]*href="\/phil\/jobs\/job-7\/plans"[^>]*>[\s\S]*E-101 Power layout/);
    // No fabricated deep-link param the viewer can't honour (P7).
    expect(html).not.toContain("?doc=");
    expect(html).not.toContain("?page=");
  });

  it("renders a governing drawing as plain text (no anchor) without jobId — zero regression", () => {
    const html = renderWithJob(FULL); // jobId omitted
    expect(html).toContain("E-101 Power layout");
    // No plans link, and the doc list carries no anchor at all.
    expect(html).not.toContain("/plans");
    expect(html).not.toContain("<a");
  });

  it("encodes the jobId in the plans link", () => {
    const html = renderWithJob(FULL, "job/7 a");
    expect(html).toContain('href="/phil/jobs/job%2F7%20a/plans"');
  });

  it("falls back to a worker-language label (never a raw id) for an unlabelled doc, still linked", () => {
    const noLabel: PhilTaskContext = {
      ...FULL,
      governingDocs: [{ documentId: "doc_raw_id_123", label: null }],
    };
    const html = renderWithJob(noLabel, "job-7");
    expect(html).toContain("Referenced drawing / spec");
    expect(html).not.toContain("doc_raw_id_123");
    expect(html).toContain('href="/phil/jobs/job-7/plans"');
  });
});
