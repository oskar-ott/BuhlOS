import { describe, expect, it, vi } from "vitest";

// AdminTopbar composes AdminSearchBox + SignOutButton (useRouter).
vi.mock("next/navigation", () => ({
  usePathname: () => "/command-centre",
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AdminTopbar } from "./AdminTopbar";

/**
 * Lean-reset redesign (2026-07-26 replica) — the top bar's right cluster:
 * search + ⌘K hint, the /settings gear, sign-out, and a STATIC viewer-initials
 * avatar chip. Doc 27 §13 (as amended): the chip is display-only — still no
 * profile dropdown on this surface.
 */

function render(initials?: string | null): string {
  return renderToString(createElement(AdminTopbar, { viewerInitials: initials }));
}

describe("AdminTopbar (lean-reset right cluster)", () => {
  it("renders search, the ⌘K hint, the settings gear and sign-out", () => {
    const html = render("KB");
    expect(html).toContain("admin-search-input");
    expect(html).toContain("admin-cmdk-hint");
    // Settings is a plain link to the #222 hub (moved off the old rail footer).
    expect(html).toContain("admin-settings-link");
    expect(html.match(/href="\/settings"/g)).toHaveLength(1);
    // Sign-out keeps the load-bearing Playwright testid.
    expect(html).toContain('data-testid="logout"');
  });

  it("renders the avatar as a STATIC chip — initials only, no dropdown/menu semantics", () => {
    const html = render("KB");
    expect(html).toContain("admin-viewer-avatar");
    expect(html).toContain(">KB<");
    // Not interactive: no button/menu wiring on the chip.
    expect(html).not.toContain("aria-haspopup");
    expect(html).not.toContain("aria-expanded");
  });

  it("no session identity → NO avatar chip (honest-or-absent), the rest intact", () => {
    const html = render(null);
    expect(html).not.toContain("admin-viewer-avatar");
    expect(html).toContain("admin-search-input");
    expect(html).toContain('data-testid="logout"');
  });
});
