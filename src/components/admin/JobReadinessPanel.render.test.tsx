import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { JobReadinessPanel } from "./JobReadinessPanel";
import {
  computeReadiness,
  defaultPrestartItems,
  type ReadinessResult,
  type ReadinessSignals,
} from "@/domains/jobs/readiness";

const CREW = [{ id: "u1", name: "Dave" }];
const ALL_TRUE = { byWorkerId: { u1: true } };
const tickedItems = () =>
  defaultPrestartItems().map((i) => ({ ...i, ticked: true, tickedBy: "Boss", tickedAt: "2026-06-18" }));

function result(over: Partial<ReadinessSignals> = {}): ReadinessResult {
  return computeReadiness({
    crew: CREW,
    inductions: ALL_TRUE,
    licences: ALL_TRUE,
    safetyDocs: ALL_TRUE,
    manualItems: tickedItems(),
    override: null,
    ...over,
  });
}

function render(r: ReadinessResult): string {
  return renderToString(
    createElement(JobReadinessPanel, { jobId: "j1", initial: r, fetchError: null })
  ).replace(/<!-- -->/g, "");
}

describe("JobReadinessPanel (#371)", () => {
  it("everything satisfied → 'Ready to start'", () => {
    const html = render(result());
    expect(html).toContain("Ready to start");
    expect(html).toContain("Pre-start readiness");
  });

  it("a blocked worker → 'Not ready to start', names the worker, offers an override", () => {
    const html = render(result({ inductions: { byWorkerId: {} } })); // Dave not inducted
    expect(html).toContain("Not ready to start");
    expect(html).toContain("Dave");
    expect(html).toContain("start anyway"); // the override affordance
    expect(html).not.toContain("Ready to start"); // never green when blocked
  });

  it("an absent register renders 'Not tracked' and only warns — never green", () => {
    const html = render(result({ safetyDocs: null }));
    expect(html).toContain("Not tracked");
    expect(html).toContain("with warnings");
    expect(html).not.toContain("Ready to start");
  });

  it("an override flags start-approval but the honest state stays not-ready (not green)", () => {
    const html = render(
      result({
        inductions: { byWorkerId: {} },
        override: { reason: "client signed a waiver", by: "Boss", at: "2026-06-18" },
      })
    );
    expect(html).toContain("Start approved by override");
    expect(html).toContain("client signed a waiver");
    expect(html).toContain("Clear override");
    expect(html).toContain("Not ready to start"); // honest state untouched
  });
});
