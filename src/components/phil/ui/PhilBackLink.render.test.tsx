import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilBackLink } from "./PhilBackLink";

/**
 * SSR smoke for the back link — must keep a ≥44px tap target (the field-glove
 * minimum) and carry the destination href + label.
 */
function render(props: Parameters<typeof PhilBackLink>[0]) {
  return renderToString(createElement(PhilBackLink, props));
}

describe("PhilBackLink", () => {
  it("renders a ≥44px link with the label and href", () => {
    const html = render({ href: "/phil/jobs", children: "All jobs" });
    expect(html).toContain("All jobs");
    expect(html).toContain("min-h-[44px]");
    expect(html).toContain('href="/phil/jobs"');
  });
});
