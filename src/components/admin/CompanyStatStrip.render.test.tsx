import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { CompanyStatStrip } from "./CompanyStatStrip";
import type { StatTile } from "@/domains/company/summary";

function render(tiles: ReadonlyArray<StatTile>, subline?: string): string {
  return renderToString(
    createElement(CompanyStatStrip, { tiles, label: "Test at a glance", subline }),
  ).replace(/<!-- -->/g, "");
}

const TILES: StatTile[] = [
  { key: "a", label: "Live quotes", value: "5", hint: "draft + submitted", tone: "neutral" },
  { key: "b", label: "Awaiting sign-off", value: "2", hint: "recorded, not reviewed", tone: "warning" },
  { key: "c", label: "Live pipeline", value: "—", hint: "sell inc GST", tone: "neutral" },
];

describe("CompanyStatStrip", () => {
  it("renders each tile's label, value and hint", () => {
    const html = render(TILES);
    expect(html).toContain("Live quotes");
    expect(html).toContain(">5<");
    expect(html).toContain("draft + submitted");
    expect(html).toContain("Awaiting sign-off");
    expect(html).toContain("recorded, not reviewed");
  });

  it("renders the optional subline when given", () => {
    expect(render(TILES, "5 quotes · 2 live")).toContain("5 quotes · 2 live");
  });

  it("omits the subline node when not given", () => {
    expect(render(TILES)).not.toContain("· 2 live");
  });

  it("renders a region with the given aria-label", () => {
    expect(render(TILES)).toContain('aria-label="Test at a glance"');
  });

  it("renders an em-dash value muted, not as a coloured alert", () => {
    // The unavailable tile (—) must use the neutral rail, never a tone rail.
    const html = render([
      { key: "x", label: "X", value: "—", hint: "no data", tone: "danger" },
    ]);
    expect(html).toContain("—");
    expect(html).toContain("border-l-border");
    expect(html).not.toContain("border-l-state-danger");
    expect(html).toContain("text-text-muted");
  });

  it("applies the value tone class for an available toned value", () => {
    const html = render([
      { key: "y", label: "Y", value: "3", hint: "go", tone: "warning" },
    ]);
    expect(html).toContain("border-l-state-warning");
    expect(html).toContain("text-state-warning");
  });
});
