import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { Inspector, type InspectorRow, type InspectorTarget } from "./Inspector";
import type { BuilderReadiness } from "@/domains/jobs/builder";

function readiness(over: Partial<BuilderReadiness> = {}): BuilderReadiness {
  return {
    state: "yes",
    stateLabel: "Ready to publish",
    tone: "success",
    blockers: [],
    warnings: [],
    blockingCount: 0,
    warningCount: 0,
    canPublish: true,
    ...over,
  };
}

function render(target: InspectorTarget, r: BuilderReadiness = readiness()): string {
  return renderToString(
    createElement(Inspector, { target, readiness: r, onGoToIssue: () => {}, onDeselect: () => {} })
  );
}

describe("Inspector — readiness view", () => {
  it("invites a selection and shows the all-clear state when ready", () => {
    const html = render({ kind: "readiness" });
    expect(html).toContain("Build readiness");
    expect(html).toContain("Select a scope line or area");
    expect(html).toContain("Ready to publish");
  });

  it("lists blockers and warnings from the real readiness model", () => {
    const r = readiness({
      state: "no",
      stateLabel: "Not ready to publish",
      tone: "danger",
      blockers: [
        { code: "name-missing", message: "Job needs a name.", severity: "error", source: "publish" },
      ],
      warnings: [
        { code: "area-no-tasks", message: "Empty area.", severity: "warning", source: "field" },
      ],
      blockingCount: 1,
      warningCount: 1,
      canPublish: false,
    });
    const html = render({ kind: "readiness" }, r);
    expect(html).toContain("Job needs a name.");
    expect(html).toContain("Empty area.");
    expect(html).toContain("Blocker");
    expect(html).toContain("field-lint");
  });
});

describe("Inspector — row view (the real selected-row inspector)", () => {
  it("inspects a scope clause with known certainty (live CertaintyChip + refs)", () => {
    const row: InspectorRow = {
      entity: "clause",
      id: "sw_1",
      title: "Supply and install DB-1",
      detail: "Includes mains tails",
      certainty: "confirmed",
      classificationLabel: "Priced",
      boqLineCount: 2,
      deliveredByCount: 1,
      requiredEvidenceCount: 3,
      warningText: null,
    };
    const html = render({ kind: "row", row });
    expect(html).toContain("Scope line");
    expect(html).toContain("Supply and install DB-1");
    expect(html).toContain("Includes mains tails");
    expect(html).toContain("Confirmed"); // CertaintyChip label
    expect(html).toContain("Priced");
    expect(html).toContain("Required proof");
  });

  it("inspects an un-reconciled clause honestly — no faked certainty", () => {
    const row: InspectorRow = {
      entity: "clause",
      id: "sw_2",
      title: "Make-safe existing",
      detail: null,
      certainty: null,
      classificationLabel: null,
      boqLineCount: 0,
      deliveredByCount: 0,
      requiredEvidenceCount: 0,
      warningText: null,
    };
    const html = render({ kind: "row", row });
    expect(html).toContain("Not reconciled yet");
    expect(html).not.toContain("Confirmed");
    expect(html).not.toContain("Required proof");
  });

  it("inspects an area as a structural facet with no certainty", () => {
    const row: InspectorRow = {
      entity: "area",
      id: "a_1",
      title: "Unit 1",
      group: "Level 1",
      spaceType: "Apartment",
      hasCustomTasks: true,
    };
    const html = render({ kind: "row", row });
    expect(html).toContain("Area");
    expect(html).toContain("Unit 1");
    expect(html).toContain("Level 1");
    expect(html).toContain("Apartment");
    expect(html).toContain("Custom override");
    expect(html).toContain("no certainty of its own");
  });
});
