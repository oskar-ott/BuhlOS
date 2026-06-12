import { describe, expect, it, vi } from "vitest";

let mockPath = "/hours";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPath,
}));
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { HoursTabs } from "./HoursTabs";

/**
 * #415 — the hours section's in-page tab bar (Day · Approvals · Weekly
 * closeout). Active state is read LIVE from usePathname() (the soft-nav
 * rule, #116→#118); this SSR test drives it by swapping the mocked path
 * per render — exact match for /hours, prefix match for the deeper tabs.
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

describe("HoursTabs (#415)", () => {
  it("renders all three tabs with their sacred hrefs (routes unchanged — push deep links keep working)", () => {
    const html = render("/hours");
    expect(html).toContain('data-testid="hours-tabs"');
    expect(html).toContain('href="/hours"');
    expect(html).toContain('href="/hours/approvals"');
    expect(html).toContain('href="/hours/weekly"');
    for (const label of ["Day", "Approvals", "Weekly closeout"]) {
      expect(html).toContain(label);
    }
  });

  it("marks exactly one tab active per route via aria-current", () => {
    expect(activeTab(render("/hours"))).toBe("Day");
    expect(activeTab(render("/hours/approvals"))).toBe("Approvals");
    expect(activeTab(render("/hours/weekly"))).toBe("Weekly closeout");
    for (const path of ["/hours", "/hours/approvals", "/hours/weekly"]) {
      expect(render(path).match(/aria-current="page"/g)).toHaveLength(1);
    }
  });

  it("deeper tabs match by prefix; the Day tab is exact-only (never lit on sibling routes)", () => {
    // Hypothetical sub-paths keep their parent tab active…
    expect(activeTab(render("/hours/approvals/anything"))).toBe("Approvals");
    expect(activeTab(render("/hours/weekly/anything"))).toBe("Weekly closeout");
    // …and never light the section root alongside themselves.
    expect(render("/hours/approvals").match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("styles the active tab per the sidebar's active convention: accent border + semibold", () => {
    const html = render("/hours/approvals");
    const active = html.match(/<a[^>]*aria-current="page"[^>]*>/)?.[0] ?? "";
    expect(active).toContain("border-accent-yellow");
    expect(active).toContain("font-semibold");
  });
});
