import { describe, expect, it, vi } from "vitest";

// NewJobRedesign uses useRouter (push on create). Stub it for the SSR smoke.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
}));

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { NewJobRedesign } from "./NewJobRedesign";

/**
 * SSR smoke for the Job Builder redesign · Wave 1 New Job screen. renderToString
 * draws the initial state — effects don't run server-side, so the blueprint
 * fetch (listBlueprints) never fires and the panel shows its honest loading
 * state. The create/blueprint behaviour is the existing, already-tested logic
 * (createJob / instantiateBlueprint); this asserts the redesigned surface mounts
 * with the draft-first framing + both paths.
 */
describe("NewJobRedesign (Job Builder redesign · Wave 1)", () => {
  it("renders both new-job paths with the draft-first framing", () => {
    const html = renderToString(createElement(NewJobRedesign));
    expect(html).toContain("Start a new job");
    expect(html).toContain("Start blank");
    expect(html).toContain("Start from a template");
    // draft-first discipline stated up front (matches the spec's core motif)
    expect(html).toContain("draft");
    expect(html).toContain("invisible to the crew");
    // the one hard requirement + the reused create affordance
    expect(html).toContain("Job name");
    expect(html).toContain("Create draft &amp; open builder");
    // blueprint path starts in its honest loading state (SSR runs no effects)
    expect(html).toContain("Loading templates");
  });
});
