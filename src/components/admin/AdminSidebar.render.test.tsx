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
    for (const heading of ["Today", "Jobs", "Hours", "People &amp; gear"]) {
      expect(html).toContain(heading);
    }
    for (const label of [
      "Command centre",
      "Observations",
      "Material requests",
      "ITP templates",
      "Weekly closeout",
      "Approvals",
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

  it("longest prefix wins: /hours vs /hours/approvals vs /hours/weekly", () => {
    expect(activeLabel(render("/hours"))).toBe("Hours");
    expect(activeLabel(render("/hours/approvals"))).toBe("Approvals");
    expect(activeLabel(render("/hours/weekly"))).toBe("Weekly closeout");
  });

  it("nested job paths keep Jobs active; templates route activates ITP templates", () => {
    expect(activeLabel(render("/v2/jobs/j1/itps"))).toBe("Jobs");
    expect(activeLabel(render("/itp-templates"))).toBe("ITP templates");
  });
});
