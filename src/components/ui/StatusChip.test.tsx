import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { StatusChip } from "./StatusChip";

/**
 * No JSX in this test file — Vitest's default esbuild transform runs the
 * classic JSX runtime, but the component itself relies on React 19's
 * automatic runtime. Calling React.createElement directly keeps the test
 * portable without changing the project-wide JSX config.
 */
function render(props: Parameters<typeof StatusChip>[0]) {
  return renderToString(createElement(StatusChip, props));
}

describe("StatusChip", () => {
  it("renders the label and a leading dot by default", () => {
    const html = render({ tone: "info", children: "Submitted" });
    expect(html).toContain("Submitted");
    expect(html).toContain("rounded-full");
    expect(html).toContain("uppercase");
  });

  it("hides the dot when dot=false", () => {
    const html = render({
      tone: "info",
      dot: false,
      children: "Submitted",
    });
    expect(html).not.toContain("rounded-full");
  });

  it("renders normal-case when uppercase=false", () => {
    const html = render({
      tone: "neutral",
      uppercase: false,
      children: "Submitted",
    });
    expect(html).not.toContain("uppercase");
    expect(html).toContain("normal-case");
  });

  it("each tone produces a distinct class set", () => {
    const tones = [
      "neutral",
      "info",
      "success",
      "warning",
      "danger",
      "navy",
      "yellow",
    ] as const;
    const seen = new Set<string>();
    for (const tone of tones) {
      const html = render({ tone, children: "x" });
      const match = html.match(/class="([^"]+)"/);
      expect(match, `tone=${tone}`).toBeTruthy();
      seen.add(match?.[1] ?? "");
    }
    expect(seen.size).toBe(tones.length);
  });
});
