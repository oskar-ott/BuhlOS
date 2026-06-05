import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// PhilTabBar (rendered by the shell) reads usePathname for the active tab and
// PhilCaptureLauncher reads useRouter; stub both for SSR.
vi.mock("next/navigation", () => ({
  usePathname: () => "/phil/jobs",
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { PhilShell } from "./PhilShell";

/**
 * Guards the shell contract at the component level (the static
 * check-shell-contract.js + the Playwright smoke also assert the marker):
 * the shell renders its data-testid marker, the page title, the body, and the
 * bottom-nav identity.
 */
function render(props: Parameters<typeof PhilShell>[0]) {
  return renderToString(createElement(PhilShell, props));
}

describe("PhilShell", () => {
  it("renders the shell marker, title, body and bottom tabs", () => {
    const html = render({ title: "Jobs", children: "PAGE BODY" });
    expect(html).toContain('data-testid="phil-shell"');
    expect(html).toContain("Jobs");
    expect(html).toContain("PAGE BODY");
    // Bottom-nav identity stays stable for the route-ownership + smoke checks.
    expect(html).toContain("Today");
    expect(html).toContain("Gear");
    expect(html).toContain("Capture");
  });
});
