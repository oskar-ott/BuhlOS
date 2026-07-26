import { describe, expect, it, vi } from "vitest";

let mockPath = "/command-centre";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPath,
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined }),
}));
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AdminMobileTabBar } from "./AdminMobileTabBar";

/**
 * Mobile admin redesign — the calm bottom tab bar replaces the old hamburger.
 * Mirrors the AdminSidebar/AdminMobileNav render-test pattern (SSR string).
 */

function render(path: string): string {
  mockPath = path;
  return renderToString(createElement(AdminMobileTabBar));
}

function source(): string {
  return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "AdminMobileTabBar.tsx"), "utf8");
}

describe("AdminMobileTabBar (mobile admin redesign)", () => {
  it("renders a mobile-only bottom tab bar with the five tabs", () => {
    const html = render("/command-centre");
    expect(html).toContain('aria-label="BuhlOS tabs"');
    expect(html).toContain("md:hidden"); // never shown on desktop
    for (const label of ["Today", "Jobs", "This week", "People", "More"]) {
      expect(html).toContain(label);
    }
  });

  it("links only the four approved admin routes; More is a button (no route)", () => {
    const html = render("/command-centre");
    expect(html).toContain('href="/command-centre"');
    expect(html).toContain('href="/v2/jobs"');
    expect(html).toContain('href="/hours/weekly"');
    expect(html).toContain('href="/employees"');
    // More opens the IA sheet — it must be a dialog trigger, not a nav link.
    expect(html).toContain('aria-haspopup="dialog"');
    // No legacy / cross-surface destinations leak in.
    for (const banned of ["/my-day", "/phil", "/admin/", ".html", "/v2/phil"]) {
      expect(html).not.toContain(`href="${banned}`);
    }
  });

  it("marks the active tab with aria-current + an accent-yellow dot", () => {
    const onToday = render("/command-centre");
    const todayAnchor = onToday.match(/<a[^>]*href="\/command-centre"[^>]*>/);
    expect(todayAnchor).not.toBeNull();
    expect(todayAnchor![0]).toContain('aria-current="page"');
    expect(onToday).toContain("bg-accent-yellow");
  });

  it("keeps This week active across the hours routes; Jobs active on a nested job", () => {
    const weekActive = (html: string) =>
      (html.match(/<a[^>]*href="\/hours\/weekly"[^>]*aria-current="page"/) ||
        html.match(/aria-current="page"[^>]*href="\/hours\/weekly"/)) != null;
    expect(weekActive(render("/hours"))).toBe(true);
    expect(weekActive(render("/hours/approvals"))).toBe(true);
    const onJob = render("/v2/jobs/j1/evidence");
    const jobsAnchor = onJob.match(/<a[^>]*href="\/v2\/jobs"[^>]*>/);
    expect(jobsAnchor![0]).toContain('aria-current="page"');
  });

  it("meets the 44px tap floor (h-16 bar, full-height tap columns)", () => {
    expect(render("/command-centre")).toContain("h-16");
  });

  it("never imports the Phil shell or tab bar (cross-shell ban)", () => {
    const src = source();
    expect(src).not.toContain("@/components/phil/PhilShell");
    expect(src).not.toContain("@/components/phil/PhilTabBar");
  });

  it("renders no badge when no counts are supplied (truth over theatre)", () => {
    // Default mount (the shell passes no counts): no red/amber badge bubbles.
    const html = render("/command-centre");
    expect(html).not.toContain("bg-state-danger");
  });
});
