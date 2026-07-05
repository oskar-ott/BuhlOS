import { describe, expect, it, vi } from "vitest";

// PlanStudioPanel mounts DocumentUploadButton, which calls useRouter().
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  usePathname: () => "/v2/jobs/j1/builder",
}));

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PlanStudioPanel } from "./PlanStudioPanel";

/**
 * SSR smoke for the #206 Plan Studio panel. renderToString draws the initial
 * (loading) state — effects never run server-side, so no fetch fires. The
 * review/accept interactions are covered by the API tests (accept-rooms in
 * src/domains/ai-drawings/ai-drawings-api.test.ts); this asserts the panel
 * mounts, states its accept contract honestly, and offers the upload + link-out
 * (reuse the shipped review, don't duplicate it).
 */
describe("PlanStudioPanel (#206)", () => {
  it("renders the header, upload, link-out and initial loading state", () => {
    const html = renderToString(
      createElement(PlanStudioPanel, {
        jobId: "j1",
        acceptedAreas: [],
        planTasksEnabled: false,
        onAreasCreated: () => undefined,
      }),
    );
    expect(html).toContain("Plan Studio");
    // honest accept contract up front (AI proposes, human accepts)
    expect(html).toContain("Nothing is created until you accept it");
    // reuse, not duplicate — links out to the shipped full review
    expect(html).toContain("Open the full plan review");
    // the builder-side upload path
    expect(html).toContain("Upload a document");
    // initial state before the client-side fetch resolves — with an ACTIVE
    // spinner, so a wait never reads as frozen/broken
    expect(html).toContain("Loading detected rooms");
    expect(html).toContain("animate-spin");
  });

  it("renders the analysisSlot BETWEEN the upload header and the rooms area (top-down flow)", () => {
    const html = renderToString(
      createElement(PlanStudioPanel, {
        jobId: "j1",
        acceptedAreas: [],
        planTasksEnabled: false,
        onAreasCreated: () => undefined,
        analysisSlot: createElement("div", {}, "ANALYSIS_SLOT_MARKER"),
      }),
    );
    const upload = html.indexOf("Upload a document");
    const slot = html.indexOf("ANALYSIS_SLOT_MARKER");
    const rooms = html.indexOf("Loading detected rooms");
    expect(upload).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(upload); // analyse sits below upload…
    expect(rooms).toBeGreaterThan(slot); // …and above the detected-rooms/accept area
  });
});
