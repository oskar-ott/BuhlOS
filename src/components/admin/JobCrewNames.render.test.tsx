import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobCrewNames } from "./JobCrewNames";

// The component refreshes the page after an assign/unassign; renderToString
// has no App Router context, so stub the hook (same pattern as sibling tests).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

/**
 * Honest-or-absent contract: before the register fetch resolves (renderToString
 * never runs effects) the component renders NOTHING — no placeholder names, no
 * skeleton. The band's crew count stays the only crew signal until real names
 * arrive client-side.
 */
describe("JobCrewNames — initial render", () => {
  it("renders nothing before the employees fetch resolves", () => {
    const html = renderToString(createElement(JobCrewNames, { jobId: "job-1" }));
    expect(html).toBe("");
  });
});
