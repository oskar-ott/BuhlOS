import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { UtilisationPanel } from "./UtilisationPanel";

/**
 * #342 — the utilisation panel's initial render (renderToString skips the mount
 * fetch). The maths are pinned by the pure/API harnesses; this guards the panel
 * mounts with its title + the honest "what's measured" description.
 */
describe("UtilisationPanel — initial render", () => {
  it("renders the title, the 7h36 basis, and a loading state", () => {
    const html = renderToString(createElement(UtilisationPanel));
    expect(html).toContain("Crew utilisation");
    expect(html).toContain("7h36");
    expect(html).toContain("Loading");
  });
});
