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
});
