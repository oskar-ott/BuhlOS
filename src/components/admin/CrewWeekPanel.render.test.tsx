import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { CrewWeekPanel } from "./CrewWeekPanel";

/**
 * #337 — the crew-week panel's initial render (renderToString skips the mount
 * fetch). The projection is pinned by the pure/API harnesses; this guards the
 * panel + its honest "currently assigned, not a forward schedule" framing.
 */
describe("CrewWeekPanel — initial render", () => {
  it("renders the title, the honest current-assignment note, and a loading state", () => {
    const html = renderToString(createElement(CrewWeekPanel));
    expect(html).toContain("Crew this week");
    expect(html).toContain("currently");
    expect(html).toContain("Loading");
  });
});
