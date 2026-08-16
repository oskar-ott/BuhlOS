import { describe, expect, it, vi } from "vitest";

let mockPath = "/hours/weekly";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPath,
}));
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { HoursTabs } from "./HoursTabs";

/**
 * #415 → lean-reset → weekly-first (owner directive 2026-08-08) — the hours
 * section's in-page tab bar, now This week · Today · Pay period. The crew
 * logs hours weekly, so the section leads with the week: /hours redirects to
 * /hours/weekly and the day view moved to /hours/today. Active state is read
 * LIVE from usePathname() (the soft-nav rule, #116→#118); this SSR test
 * drives it by swapping the mocked path per render — all tabs prefix-match.
 *
 * /hours/approvals deliberately has NO tab (redesign) but the route stays
 * live — the strip must simply light nothing there, never 404 it.
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

describe("HoursTabs (#415, weekly-first)", () => {
  it("renders the three tabs, This week FIRST (the crew's weekly rhythm leads)", () => {
    const html = render("/hours/weekly");
    expect(html).toContain('data-testid="hours-tabs"');
    expect(html).toContain('href="/hours/weekly"');
    expect(html).toContain('href="/hours/today"');
    expect(html).toContain('href="/hours/period"');
    for (const label of ["This week", "Today", "Pay period"]) {
      expect(html).toContain(label);
    }
    // Order: the weekly board is the landing tab, the day view a drill-in.
    expect(html.indexOf(">This week<")).toBeLessThan(html.indexOf(">Today<"));
  });

  it("carries NO tab for the section root — /hours itself redirects to the weekly board", () => {
    const html = render("/hours/weekly");
    expect(html).not.toContain('href="/hours"<');
    expect(html.match(/href="\/hours"/g)).toBeNull();
  });

  it("carries NO Approvals tab — the route stays live but is a drill-in", () => {
    const html = render("/hours/weekly");
    expect(html).not.toContain('href="/hours/approvals"');
    expect(html).not.toContain(">Approvals<");
  });

  it("carries the cross-surface 'Log my hours' link into the field hours flow — a link, never a tab", () => {
    // Admin staff log their OWN tool-day hours in Phil (owner decision
    // 2026-08-02); since the field home bounces the admin tier to the office
    // (owner pull 2026-08-16), this is the office's one path into that flow.
    const html = render("/hours/weekly");
    expect(html).toContain('data-testid="hours-log-my-own"');
    expect(html).toContain('href="/phil/hours"');
    expect(html).toContain("Log my hours");
    // Never active: it is not one of this section's tabs.
    const link = html.match(/<a[^>]*data-testid="hours-log-my-own"[^>]*>/)?.[0] ?? "";
    expect(link).not.toContain('aria-current');
  });

  it("marks exactly one tab active per tab route via aria-current", () => {
    expect(activeTab(render("/hours/weekly"))).toBe("This week");
    expect(activeTab(render("/hours/today"))).toBe("Today");
    expect(activeTab(render("/hours/period"))).toBe("Pay period");
    for (const path of ["/hours/weekly", "/hours/today", "/hours/period"]) {
      expect(render(path).match(/aria-current="page"/g)).toHaveLength(1);
    }
  });

  it("lights nothing on /hours/approvals (no tab claims it)", () => {
    expect(render("/hours/approvals").match(/aria-current="page"/g)).toBeNull();
  });

  it("tabs match by prefix — sub-paths keep their parent tab active, one at a time", () => {
    expect(activeTab(render("/hours/weekly/anything"))).toBe("This week");
    expect(activeTab(render("/hours/period/anything"))).toBe("Pay period");
    expect(activeTab(render("/hours/today/anything"))).toBe("Today");
    expect(render("/hours/weekly").match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("styles the active tab per the sidebar's active convention: accent border + semibold", () => {
    const html = render("/hours/weekly");
    const active = html.match(/<a[^>]*aria-current="page"[^>]*>/)?.[0] ?? "";
    expect(active).toContain("border-accent-yellow");
    expect(active).toContain("font-semibold");
  });

  it("exposes the scroll strip as a test target and keeps overflow-x-auto (#669)", () => {
    const html = render("/hours/weekly");
    expect(html).toContain('data-testid="hours-tabs-scroll"');
    expect(html).toContain("overflow-x-auto");
  });

  it("renders NO edge fade at SSR — honest, only shown once client-measured (#669, P7)", () => {
    // canScrollLeft/Right default false (not yet measured), so the server must
    // not paint a fade implying hidden tabs that may not exist.
    const html = render("/hours/weekly");
    expect(html).not.toContain("bg-gradient-to-r");
    expect(html).not.toContain("bg-gradient-to-l");
  });
});
