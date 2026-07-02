import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ITPPointCard } from "./ITPPointCard";
import type { ITPInstance, ITPTemplatePoint } from "@/domains/itp/types";

/**
 * SSR render tests (node env — no jsdom; effects never run under
 * renderToString). They pin the #520 defect-from-failure contract: the
 * "Report defect" affordance appears ONLY when a value point's derived
 * verdict is FAIL (P10 — zero new chrome on passing/unrecorded points) and
 * only when the parent wires onReportDefect.
 */

const valuePoint: ITPTemplatePoint = {
  id: "pt_ir",
  label: "Insulation resistance",
  type: "value",
  required: true,
  unit: "MΩ",
  min: 1,
  max: null,
};

function instanceWith(results: ITPInstance["results"]): ITPInstance {
  return {
    id: "itp_1",
    templateId: "tpl_1",
    templateSnapshot: { name: "Final test", points: [valuePoint] },
    scope: "job",
    status: "in-progress",
    results,
    createdAt: "2026-06-01T00:00:00.000Z",
    createdBy: "u_1",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

const failResult = {
  pt_ir: {
    value: 0.4,
    byUserId: "u_1",
    byUsername: "sam",
    at: "2026-06-01T01:00:00.000Z",
  },
};

const passResult = {
  pt_ir: {
    value: 2.5,
    byUserId: "u_1",
    byUsername: "sam",
    at: "2026-06-01T01:00:00.000Z",
  },
};

function render(
  results: ITPInstance["results"],
  onReportDefect?: (prefill: { pointId: string; title: string; description: string }) => void,
): string {
  return renderToString(
    createElement(ITPPointCard, {
      jobId: "job-1",
      instance: instanceWith(results),
      point: valuePoint,
      viewer: { id: "u_1", role: "tradie" },
      onSaved: () => {},
      onError: () => {},
      ...(onReportDefect ? { onReportDefect } : {}),
    }),
  ).replace(/<!-- -->/g, "");
}

describe("ITPPointCard — #520 report-defect affordance", () => {
  // NOTE: the header pill on a freshly-mounted recorded point reads "Saved"
  // (phase seeds from existing.at) rather than Pass/Fail — the affordance
  // keys off the DERIVED verdict (valuePassFail), so it is asserted via its
  // testid, not the pill copy.
  it("shows Report defect when the derived verdict is Fail", () => {
    const html = render(failResult, () => {});
    expect(html).toContain('data-testid="itp-report-defect"');
    expect(html).toContain("Report defect");
  });

  it("shows NO affordance when the verdict is Pass (P10 — no new chrome)", () => {
    const html = render(passResult, () => {});
    expect(html).not.toContain('data-testid="itp-report-defect"');
    expect(html).not.toContain("Report defect");
  });

  it("shows NO affordance on an unrecorded point", () => {
    const html = render({}, () => {});
    expect(html).not.toContain('data-testid="itp-report-defect"');
  });

  it("shows NO affordance when the parent doesn't wire onReportDefect", () => {
    const html = render(failResult);
    expect(html).not.toContain('data-testid="itp-report-defect"');
  });
});
