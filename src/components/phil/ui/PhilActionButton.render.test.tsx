import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilActionButton } from "./PhilActionButton";

/**
 * SSR smoke for the Phil accent CTA. Verifies it renders a real <button> (not
 * a div), defaults type="button", stays on-token (accent-yellow on navy), and
 * holds the ≥44px field-glove tap target.
 *
 * Props go through this helper (not an inline createElement literal) to satisfy
 * the children-required prop type without tripping react/no-children-prop.
 */
function render(props: Parameters<typeof PhilActionButton>[0]) {
  return renderToString(createElement(PhilActionButton, props));
}

describe("PhilActionButton", () => {
  it("renders a button with the label and an explicit type", () => {
    const html = render({ children: "Capture evidence" });
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    expect(html).toContain("Capture evidence");
  });

  it("is the on-token accent control sized for gloved taps", () => {
    const lg = render({ children: "x", size: "lg" });
    expect(lg).toContain("bg-accent-yellow");
    expect(lg).toContain("text-brand-navy");
    expect(lg).toContain("h-12");
    expect(render({ children: "x", size: "md" })).toContain("h-11");
  });

  it("forwards the disabled attribute", () => {
    expect(render({ children: "x", disabled: true })).toContain("disabled");
  });
});
