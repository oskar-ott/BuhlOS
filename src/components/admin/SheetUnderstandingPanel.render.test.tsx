import { describe, expect, it, vi } from "vitest";

// DocumentsList renders DocumentUploadButton, which calls useRouter().
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
  usePathname: () => "/v2/jobs/j1/documents",
}));

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { SheetUnderstandingPanel } from "./SheetUnderstandingPanel";
import { DocumentsList } from "./DocumentsList";
import type { Job } from "@/domains/jobs/types";

/**
 * SSR smoke for the #197 sheet-understanding panel. renderToString draws the
 * initial (loading) state — effects never run server-side, so no fetch fires.
 * The run/review interactions are covered by the API tests
 * (src/domains/ai-drawings/ai-drawings-api.test.ts); this asserts the panel
 * mounts, states its purpose honestly, and only appears on the documents list
 * when the dark flag prop is on.
 */

const JOB = { id: "j1", name: "Test job" } as unknown as Job;

describe("SheetUnderstandingPanel (#197)", () => {
  it("renders the panel header + loading state", () => {
    const html = renderToString(
      createElement(SheetUnderstandingPanel, { jobId: "j1" }),
    );
    expect(html).toContain("Plan analysis");
    expect(html).toContain("Loading plan analysis");
    // an ACTIVE spinner, so the load never reads as frozen/broken
    expect(html).toContain("animate-spin");
    // states the review contract up front
    expect(html).toContain("your corrections always win");
  });

  it("DocumentsList mounts the panel ONLY when the flag prop is on (dark)", () => {
    const off = renderToString(
      createElement(DocumentsList, {
        job: JOB,
        initialDocuments: [],
        fetchError: null,
      }),
    );
    expect(off).not.toContain("Plan analysis");

    const on = renderToString(
      createElement(DocumentsList, {
        job: JOB,
        initialDocuments: [],
        fetchError: null,
        aiDrawingsEnabled: true,
      }),
    );
    expect(on).toContain("Plan analysis");
  });
});
