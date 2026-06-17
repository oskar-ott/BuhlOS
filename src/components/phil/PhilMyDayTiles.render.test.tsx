import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilMyDayTiles } from "./PhilMyDayTiles";
import { CaptureLauncherProvider } from "./captureLauncherContext";

// The tiles read the capture-launcher context, so render them inside the
// provider (the shell mounts it in production).
function render() {
  return renderToString(
    createElement(CaptureLauncherProvider, null, createElement(PhilMyDayTiles)),
  );
}

describe("PhilMyDayTiles (render)", () => {
  it("shows the four day-to-day quick actions, labelled from the real Capture options", () => {
    const html = render();
    expect(html).toContain("Quick actions");
    // Labels come straight from WORKER_CAPTURE_OPTIONS / OFFICE_CAPTURE_OPTIONS
    // (one dialect, P11) — the same words the launcher form then shows.
    expect(html).toContain("Blocker");
    expect(html).toContain("Need material");
    expect(html).toContain("Issue / defect");
    expect(html).toContain("Fine / ticket / paperwork");
  });

  it("renders each action as its own button (a 2×2 grid of four)", () => {
    const html = render();
    const buttons = html.match(/<button/g) ?? [];
    expect(buttons.length).toBe(4);
  });

  it("never paints the internal observation type key (no raw 'material_request')", () => {
    const html = render();
    expect(html).not.toContain("material_request");
    expect(html).not.toContain("observation");
  });
});
