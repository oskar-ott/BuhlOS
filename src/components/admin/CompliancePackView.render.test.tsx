import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { CompliancePackView } from "./CompliancePackView";
import type { CompliancePack } from "@/domains/itp/compliance-pack";

/**
 * Render guards for the printable pack (#286) — what actually lands in a
 * builder's hands. Model honesty is pinned in compliance-pack.test.ts;
 * these pin that the document SHOWS it: watermark text, Not recorded,
 * override block, archived count, honest empty pack.
 */

const base: CompliancePack = {
  jobName: "Riverside",
  jobId: "j1",
  jobRef: "BW-12",
  siteAddress: "12 River Rd, Lane Cove NSW 2066",
  generatedAt: "2026-06-12T10:00:00.000Z",
  overridesNote: "Independence override justifications are sourced from the job audit log (last 12 months). Older overrides remain in the audit record.",
  summary: [
    {
      id: "i1",
      templateName: "Energisation QA",
      scopeLine: "Whole job",
      statusLabel: "Signed off",
      signedOffBy: "boss",
      signedOffAt: "2026-06-03T00:00:00.000Z",
      progress: { done: 2, total: 2 },
    },
  ],
  instances: [
    {
      id: "i1",
      templateName: "Energisation QA",
      scopeLine: "Whole job",
      status: "signed-off",
      statusLabel: "Signed off",
      inProgress: false,
      awaitingSignOff: false,
      progress: { done: 2, total: 2 },
      evidenceCoverage: { required: 1, photographed: 1 },
      points: [
        {
          id: "p1",
          label: "Torque check",
          type: "value",
          required: true,
          recorded: true,
          valueLabel: "15 Nm",
          passFail: "pass",
          note: "ok",
          photoUrl: "https://blob/x.jpg",
          byUsername: "sparky",
          at: "2026-06-02T01:00:00.000Z",
        },
        {
          id: "p2",
          label: "Labels fitted",
          type: "signoff",
          required: true,
          recorded: false,
          valueLabel: null,
          passFail: null,
          note: null,
          photoUrl: null,
          byUsername: null,
          at: null,
        },
      ],
      signOff: {
        signedOffBy: "boss",
        signedOffAt: "2026-06-03T00:00:00.000Z",
        overrideJustification: "Solo job — recorded most points myself",
      },
      createdAt: "2026-06-01T00:00:00.000Z",
    },
  ],
  archivedCount: 2,
};

describe("CompliancePackView", () => {
  it("cover, summary, evidence coverage, points, photos, sign-off + override all render", () => {
    const html = renderToString(createElement(CompliancePackView, { pack: base }));
    // Professional letterhead: doc title + the real bühl electrical identity.
    expect(html).toContain("Compliance Pack");
    expect(html).toContain("bühl electrical");
    expect(html).toContain("ABN 61 204 887 113");
    expect(html).toContain("Inspection register");
    expect(html).toContain("Riverside");
    expect(html).toContain("Ref BW-12");
    expect(html).toContain("2 archived");
    expect(html).toContain("not included");
    expect(html).toContain("Energisation QA");
    expect(html).toContain("Torque check");
    expect(html).toContain("15 Nm");
    expect(html).toContain("sparky");
    expect(html).toContain("Not recorded");
    expect(html).toContain("https://blob/x.jpg");
    expect(html).toContain("evidence-required points photographed");
    expect(html).toContain("Signed off by");
    expect(html).toMatch(/Signed off by <!-- -->boss/);
    expect(html).toContain("Independence override:");
    expect(html).toContain("Solo job");
    expect(html).toContain("audit log");
  });

  it("in-progress watermark text is loud and literal", () => {
    const pack: CompliancePack = {
      ...base,
      instances: [
        { ...base.instances[0]!, inProgress: true, awaitingSignOff: false, signOff: null },
      ],
    };
    const html = renderToString(createElement(CompliancePackView, { pack }));
    expect(html).toContain("In progress — not a completed record");
  });

  it("witnessed-but-unsigned reads awaiting sign-off — distinct from in-progress", () => {
    const pack: CompliancePack = {
      ...base,
      instances: [
        { ...base.instances[0]!, inProgress: false, awaitingSignOff: true, signOff: null },
      ],
    };
    const html = renderToString(createElement(CompliancePackView, { pack }));
    expect(html).toContain("awaiting sign-off");
    expect(html).not.toContain("not a completed record");
  });

  it("empty job exports an honest one-pager, not an error", () => {
    const pack: CompliancePack = { ...base, summary: [], instances: [], archivedCount: 0 };
    const html = renderToString(createElement(CompliancePackView, { pack }));
    expect(html).toContain("intentionally empty");
    expect(html).not.toContain("Summary");
  });
});
