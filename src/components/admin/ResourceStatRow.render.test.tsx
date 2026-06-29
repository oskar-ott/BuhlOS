import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ResourceStatRow } from "./ResourceStatRow";
import type { StatTile } from "@/domains/resources/summary";

function render(tiles: ReadonlyArray<StatTile>): string {
  return renderToString(
    createElement(ResourceStatRow, { tiles, label: "Test row" }),
  ).replace(/<!-- -->/g, "");
}

describe("ResourceStatRow", () => {
  it("renders each tile's label, value and hint", () => {
    const html = render([
      { key: "a", label: "In use", value: "5", hint: "issued to crew", tone: "neutral" },
      { key: "b", label: "Available", value: "9", hint: "in store", tone: "success" },
    ]);
    expect(html).toContain("In use");
    expect(html).toContain("5");
    expect(html).toContain("issued to crew");
    expect(html).toContain("Available");
    expect(html).toContain("9");
  });

  it("sets the region aria-label", () => {
    const html = render([
      { key: "a", label: "X", value: "1", hint: "h", tone: "neutral" },
    ]);
    expect(html).toContain('aria-label="Test row"');
  });

  it("applies the danger accent to a danger-tone value", () => {
    const html = render([
      { key: "d", label: "Damaged / missing", value: "3", hint: "needs action", tone: "danger" },
    ]);
    expect(html).toContain("text-rose-700");
  });

  it("mutes a '—' value regardless of tone (an absent signal never reads as an alert)", () => {
    const html = render([
      { key: "x", label: "On site", value: "—", hint: "not tracked", tone: "danger" },
    ]);
    // Value cell is muted, not the danger accent.
    expect(html).toContain("text-text-muted");
    expect(html).not.toContain("text-rose-700");
  });
});
