import { describe, expect, it, vi } from "vitest";

let mockPath = "/command-centre";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPath,
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AdminSidebar } from "./AdminSidebar";

/**
 * #187 — one grouped sidebar, nothing dead, longest-prefix active state.
 * #415 — hours collapsed to ONE sidebar item; Approvals / Weekly closeout
 * moved into the in-page HoursTabs bar (see HoursTabs.render.test.tsx).
 */

function render(path: string): string {
  mockPath = path;
  return renderToString(createElement(AdminSidebar));
}

function activeLabel(html: string): string | null {
  const m = html.match(/aria-current="page"[^>]*>.*?<span[^>]*>([^<]+)<\/span>/);
  return m ? m[1]! : null;
}

describe("AdminSidebar (#187)", () => {
  it("renders the grouped IA with every live surface and NO dead items", () => {
    const html = render("/command-centre");
    for (const heading of ["Today", "Jobs", "Hours", "People &amp; gear", "Company"]) {
      expect(html).toContain(heading);
    }
    for (const label of [
      "Command centre",
      "From site",
      "Material requests",
      "Quotes",
      "Defects",
      "ITP templates",
      "Dayworks",
      "Employees",
      "Gear",
      "Reports",
    ]) {
      expect(html).toContain(label);
    }
    // hide-unfinished rule: no UC pills, no unclickable entries
    expect(html).not.toContain("UC");
    expect(html).not.toContain("cursor-not-allowed");
    expect(html).not.toContain("aria-disabled");
  });

  it("shows ONE Hours item (#415) — Approvals / Weekly closeout live in the in-page tabs, not here", () => {
    const html = render("/command-centre");
    expect(html.match(/href="\/hours"/g)).toHaveLength(1);
    expect(html).not.toContain('href="/hours/approvals"');
    expect(html).not.toContain('href="/hours/weekly"');
    expect(html).not.toContain("Approvals");
    expect(html).not.toContain("Weekly closeout");
  });

  it("the single Hours item stays active across all three hours routes (#415)", () => {
    expect(activeLabel(render("/hours"))).toBe("Hours");
    expect(activeLabel(render("/hours/approvals"))).toBe("Hours");
    expect(activeLabel(render("/hours/weekly"))).toBe("Hours");
  });

  it("nested job paths keep Jobs active; templates route activates ITP templates", () => {
    expect(activeLabel(render("/v2/jobs/j1/itps"))).toBe("Jobs");
    expect(activeLabel(render("/itp-templates"))).toBe("ITP templates");
  });

  it("the Defects register (#414) sits in the Jobs group and activates on /defects", () => {
    const html = render("/command-centre");
    expect(html.match(/href="\/defects"/g)).toHaveLength(1);
    expect(activeLabel(render("/defects"))).toBe("Defects");
    // Filtered deep links keep it active too (URL-driven filters, #216).
    expect(activeLabel(render("/defects/anything"))).toBe("Defects");
  });

  it("Reports (#316) sits in the Company group and activates on /reports", () => {
    const html = render("/command-centre");
    expect(html.match(/href="\/reports"/g)).toHaveLength(1);
    expect(activeLabel(render("/reports"))).toBe("Reports");
  });

  it("Quotes (#183) sits in the Jobs group and stays active into the builder", () => {
    const html = render("/command-centre");
    expect(html.match(/href="\/v2\/quotes"/g)).toHaveLength(1);
    expect(activeLabel(render("/v2/quotes"))).toBe("Quotes");
    // Builder deep link keeps the item active; the /v2/jobs prefix must NOT
    // steal it (longest-prefix rule, distinct prefixes).
    expect(activeLabel(render("/v2/quotes/qv2_abc123"))).toBe("Quotes");
    expect(activeLabel(render("/v2/jobs/j1"))).toBe("Jobs");
  });

  it("the footer carries a single Settings link to the /settings hub (#222), not a nav-group item", () => {
    const html = render("/command-centre");
    // Present, links to the hub, and is a real <Link> (not a UC span).
    expect(html).toContain(">Settings<");
    expect(html.match(/href="\/settings"/g)).toHaveLength(1);
    // The hub replaced the two specific footer links — the sidebar footer is a
    // single Settings entry again; the hub itself links on to those pages.
    expect(html).not.toContain('href="/settings/notifications"');
    expect(html).not.toContain('href="/settings/task-rules"');
    // It lives next to sign-out in the footer — sign-out is still rendered.
    expect(html).toContain("Sign out");
    // The footer link stays active across the whole /settings subtree
    // (longest-prefix: /settings, /settings/notifications, /settings/task-rules).
    // React SSR emits aria-current before href on the same anchor, so assert
    // both are present on the one <a> (match up to the next tag close).
    for (const path of ["/settings", "/settings/notifications", "/settings/task-rules"]) {
      const onSettings = render(path);
      const anchor = onSettings.match(/<a[^>]*href="\/settings"[^>]*>/);
      expect(anchor, `expected a Settings anchor when on ${path}`).not.toBeNull();
      expect(anchor![0]).toContain('aria-current="page"');
    }
  });
});
