import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { SaveAsBlueprintCard } from "./SaveAsBlueprintCard";

/**
 * Render guards for the #191 builder action. The picker
 * (StartFromBlueprintCard) loads via fetch on mount, so it's covered by
 * the API harness + mapper units rather than SSR; this pins the save card's
 * honest capture-set copy and the form affordance.
 */

describe("SaveAsBlueprintCard", () => {
  it("renders the save action with the strip-set promise (no site/client/dates)", () => {
    const html = renderToString(createElement(SaveAsBlueprintCard, { jobId: "j1" }));
    expect(html).toContain("Save as a template");
    expect(html).toContain("blueprint-save-open");
    // The honesty line: capture set is structure-only.
    expect(html).toContain("not the site, client, dates or assignment");
  });
});
