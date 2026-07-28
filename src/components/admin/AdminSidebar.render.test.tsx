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
 * #187 — one nav, nothing dead, longest-prefix active state.
 * #415 — hours collapsed to ONE nav item; Approvals / Weekly closeout moved
 * into the in-page HoursTabs bar (see HoursTabs.render.test.tsx).
 * Lean-reset redesign (2026-07-26) — the nav renders as a horizontal pill row
 * in the top bar (flattened from NAV_GROUPS; group headings live on in the ⌘K
 * palette). The component keeps the AdminSidebar name for guard continuity.
 * Settings + sign-out moved to AdminTopbar (see AdminTopbar.render.test.tsx).
 */

function render(path: string, hiddenHrefs?: string[]): string {
  mockPath = path;
  return renderToString(createElement(AdminSidebar, hiddenHrefs ? { hiddenHrefs } : {}));
}

function activeLabel(html: string): string | null {
  const m = html.match(/aria-current="page"[^>]*>.*?<span[^>]*>([^<]+)<\/span>/);
  return m ? m[1]! : null;
}

describe("AdminSidebar (#187 · lean-reset top nav)", () => {
  it("renders every live surface as a pill and NO dead items", () => {
    const html = render("/command-centre");
    for (const label of [
      "Command centre",
      "Jobs",
      "Hours",
      "Employees",
      "Gear",
    ]) {
      expect(html).toContain(label);
    }
    // hide-unfinished rule: no UC pills, no unclickable entries
    expect(html).not.toContain("UC");
    expect(html).not.toContain("cursor-not-allowed");
    expect(html).not.toContain("aria-disabled");
  });

  it("is a single horizontal row that scrolls, never wraps (flag-dependent overflow)", () => {
    const html = render("/command-centre");
    // The HoursTabs scroll pattern: overflow-x-auto strip + shrink-0 items.
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("shrink-0");
    expect(html).not.toContain("flex-wrap");
    // No group headings render in the strip — the flattened IA is the row.
    expect(html).not.toContain("People &amp; gear");
    expect(html).not.toContain(">Today<");
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

  it("the active pill takes the navy treatment; the rest are ghost pills", () => {
    const html = render("/command-centre");
    const anchor = html.match(/<a[^>]*aria-current="page"[^>]*>/);
    expect(anchor).not.toBeNull();
    expect(anchor![0]).toContain("bg-brand-navy");
    expect(anchor![0]).toContain("text-text-inverse");
    // Exactly one navy pill.
    expect(html.match(/bg-brand-navy/g)).toHaveLength(1);
  });

  it("nested job paths keep Jobs active", () => {
    expect(activeLabel(render("/v2/jobs/j1/itps"))).toBe("Jobs");
    expect(activeLabel(render("/v2/jobs/j1"))).toBe("Jobs");
  });

  it("#760: hides owner-disabled features", () => {
    // Owner turned Employees + Gear off.
    const html = render("/command-centre", ["/employees", "/gear"]);
    expect(html).not.toContain('href="/employees"');
    expect(html).not.toContain('href="/gear"');
    // The rest of the IA is intact.
    expect(html).toContain('href="/v2/jobs"');
    expect(html).toContain("Hours");
    expect(html).toContain("Command centre");
  });

  it("carries no Settings or sign-out — those moved to the top bar's right cluster", () => {
    const html = render("/command-centre");
    expect(html).not.toContain('href="/settings"');
    expect(html).not.toContain("Sign out");
  });
});
