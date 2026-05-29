import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilCaptureLauncher } from "./PhilCaptureLauncher";

// The launcher uses useRouter for the evidence deep-link; stub it for SSR.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

/**
 * SSR smoke for the reworked Capture launcher. With initialJobId set the first
 * view is the chooser (the open-toggle effect doesn't run under renderToString),
 * so this verifies the chooser composition: the evidence path is preserved as
 * the prominent option, and the worker-facing classification labels render.
 * Submission/interaction is covered by philCapture.test.ts (payload shape) and
 * observations-api.test.ts (the POST).
 */
describe("PhilCaptureLauncher", () => {
  it("renders nothing when closed", () => {
    const html = renderToString(
      createElement(PhilCaptureLauncher, { open: false, onClose: () => {} })
    );
    expect(html).toBe("");
  });

  it("shows the capture chooser for a known job (photo + classifications)", () => {
    const html = renderToString(
      createElement(PhilCaptureLauncher, {
        open: true,
        onClose: () => {},
        initialJobId: "job-1",
      })
    );
    // The existing evidence path stays the prominent first option.
    expect(html).toContain("Take a photo / evidence");
    expect(html).toContain("Or log something");
    // Worker-facing classification labels (never the internal type names).
    expect(html).toContain("Site note");
    expect(html).toContain("Blocker");
    expect(html).toContain("Need material");
    expect(html).toContain("Question for office");
    expect(html).toContain("Not sure — office review");
  });
});
