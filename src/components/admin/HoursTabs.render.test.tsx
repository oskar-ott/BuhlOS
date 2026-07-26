import { describe, expect, it, vi } from "vitest";

let mockPath = "/hours";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPath,
}));
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { HoursTabs } from "./HoursTabs";

/**
 * #415 → lean-reset redesign — the hours section's in-page tab bar (Today ·
 * This week · Pay period). Active state is read LIVE from usePathname() (the
 * soft-nav rule, #116→#118); this SSR test drives it by swapping the mocked
 * path per render — exact match for /hours, prefix match for the deeper tabs.
 *
 * /hours/approvals deliberately has NO tab any more (redesign) but the route
 * stays live — the strip must simply light nothing there, never 404 it.
 */

function render(path: string): string {
  mockPath = path;
  return renderToString(createElement(HoursTabs));
}

/** Label of the tab carrying aria-current="page" — the anchors are plain
 *  text children, same extraction approach as AdminSidebar.render.test.tsx. */
function activeTab(html: string): string | null {
  const m = html.match(/aria-current="page"[^>]*>([^<]+)<\/a>/);
  return m ? m[1]! : null;
}

describe("HoursTabs (#415, lean-reset)", () => {
  it("renders the three tabs with their sacred hrefs (routes unchanged — push deep links keep working)", () => {
    const html = render("/hours");
    expect(html).toContain('data-testid="hours-tabs"');
    expect(html).toContain('href="/hours"');
    expect(html).toContain('href="/hours/weekly"');
    expect(html).toContain('href="/hours/period"');
    for (const label of ["Today", "This week", "Pay period"]) {
      expect(html).toContain(label);
    }
  });

  it("carries NO Approvals tab — the route stays live but is a drill-in from Today", () => {
    const html = render("/hours");
    expect(html).not.toContain('href="/hours/approvals"');
    expect(html).not.toContain(">Approvals<");
  });

  it("marks exactly one tab active per tab route via aria-current", () => {
    expect(activeTab(render("/hours"))).toBe("Today");
    expect(activeTab(render("/hours/weekly"))).toBe("This week");
    expect(activeTab(render("/hours/period"))).toBe("Pay period");
    for (const path of ["/hours", "/hours/weekly", "/hours/period"]) {
      expect(render(path).match(/aria-current="page"/g)).toHaveLength(1);
    }
  });

  it("lights nothing on /hours/approvals (no tab claims it, Today is exact-only)", () => {
    expect(render("/hours/approvals").match(/aria-current="page"/g)).toBeNull();
  });

  it("deeper tabs match by prefix; the Today tab is exact-only (never lit on sibling routes)", () => {
    // Hypothetical sub-paths keep their parent tab active…
    expect(activeTab(render("/hours/weekly/anything"))).toBe("This week");
    expect(activeTab(render("/hours/period/anything"))).toBe("Pay period");
    // …and never light the section root alongside themselves.
    expect(render("/hours/weekly").match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("styles the active tab per the sidebar's active convention: accent border + semibold", () => {
    const html = render("/hours/weekly");
    const active = html.match(/<a[^>]*aria-current="page"[^>]*>/)?.[0] ?? "";
    expect(active).toContain("border-accent-yellow");
    expect(active).toContain("font-semibold");
  });

  it("exposes the scroll strip as a test target and keeps overflow-x-auto (#669)", () => {
    const html = render("/hours");
    expect(html).toContain('data-testid="hours-tabs-scroll"');
    expect(html).toContain("overflow-x-auto");
  });

  it("renders NO edge fade at SSR — honest, only shown once client-measured (#669, P7)", () => {
    // canScrollLeft/Right default false (not yet measured), so the server must
    // not paint a fade implying hidden tabs that may not exist.
    const html = render("/hours");
    expect(html).not.toContain("bg-gradient-to-r");
    expect(html).not.toContain("bg-gradient-to-l");
  });
});
