import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { Button } from "./Button";

/**
 * No JSX in this test file — Vitest's default esbuild transform runs the
 * classic JSX runtime while the component relies on React 19's automatic
 * runtime; createElement keeps the test portable (the StatusChip.test pattern).
 *
 * #662 — the shared `sm` button must clear a ≥44px touch floor on phones
 * (h-11) while collapsing to the compact 32px (h-8) density at the `sm`
 * breakpoint and up. These assertions lock that, the other sizes, the default,
 * and the documented twMerge override behaviour so the ripple is safe.
 */
function render(props: Parameters<typeof Button>[0]) {
  return renderToString(createElement(Button, props));
}

describe("Button", () => {
  it('size="sm" carries the 44px touch floor and the sm-breakpoint collapse', () => {
    const html = render({ size: "sm", children: "Approve" });
    expect(html).toContain("h-11"); // 44px below the sm breakpoint
    expect(html).toContain("sm:h-8"); // back to 32px density at sm+
    expect(html).toContain("Approve");
  });

  it("leaves the md and lg sizes untouched", () => {
    expect(render({ size: "md", children: "x" })).toContain("h-10");
    expect(render({ size: "lg", children: "x" })).toContain("h-12");
  });

  it("defaults to the md size", () => {
    const html = render({ children: "x" });
    expect(html).toContain("h-10");
    expect(html).not.toContain("h-11");
  });

  it("lets a caller height override win via twMerge while keeping the sm collapse", () => {
    // A caller passing its own height (e.g. the tiny ghost buttons) drops the
    // base h-11 but the responsive sm:h-8 variant survives — documented twMerge
    // behaviour the QuoteBuilderClient 'manage presets' button relies on.
    const html = render({ size: "sm", className: "h-7", children: "x" });
    expect(html).toContain("h-7");
    expect(html).not.toContain("h-11");
    expect(html).toContain("sm:h-8");
  });
});
