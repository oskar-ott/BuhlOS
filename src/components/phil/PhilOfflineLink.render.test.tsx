import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilOfflineLink } from "./PhilOfflineLink";

/**
 * PhilOfflineLink must render the SAME anchor a Next <Link> would — the Phil
 * render/smoke specs (PhilTabBar, PhilJobsList, PhilBackLink…) assert on
 * `href="/phil/..."`, so the offline-aware swap must be transparent at render
 * time. The offline/online click behaviour itself is covered by the pure
 * decidePhilLinkNavigation tests + warmPhilPageCache tests.
 */
describe("PhilOfflineLink (render parity with <Link>)", () => {
  it("renders an anchor carrying the href, className, children and aria-*", () => {
    const html = renderToString(
      createElement(
        PhilOfflineLink,
        { href: "/phil/jobs/job-1", className: "row", "aria-label": "Open job 1" },
        "Open job 1",
      ),
    );
    expect(html).toContain('href="/phil/jobs/job-1"');
    expect(html).toContain('class="row"');
    expect(html).toContain('aria-label="Open job 1"');
    expect(html).toContain("Open job 1");
    expect(html.startsWith("<a")).toBe(true);
  });
});
