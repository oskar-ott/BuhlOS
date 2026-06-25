import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let mockPath = "/command-centre";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPath,
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AdminMobileNav } from "./AdminMobileNav";

/**
 * Admin mobile nav (audit fix) — the sidebar is desktop-only, so below md the
 * shell had no reachable navigation. This pins the md:hidden hamburger trigger.
 * The drawer contents reuse NAV_GROUPS (covered by AdminSidebar.render.test.tsx)
 * and only render once opened, which SSR can't drive — so the smoke asserts the
 * entry point exists, is desktop-hidden, and meets the 44px tap floor.
 */
function render(path: string): string {
  mockPath = path;
  return renderToString(createElement(AdminMobileNav));
}

describe("AdminMobileNav (audit — mobile admin navigation)", () => {
  it("renders a hamburger trigger that is hidden at md+ and meets the 44px tap floor", () => {
    const html = render("/command-centre");
    expect(html).toContain('aria-label="Open navigation"');
    // desktop-hidden (the sidebar takes over at md+)
    expect(html).toContain("md:hidden");
    // 44px square touch target (h-11 w-11)
    expect(html).toMatch(/h-11 w-11/);
  });

  it("starts closed — the drawer dialog is not in the initial markup", () => {
    const html = render("/command-centre");
    // Drawer returns null until opened, so no dialog on first paint.
    expect(html).not.toContain('role="dialog"');
  });

  it("renders a sign-out control in the drawer — the only sign-out path on mobile", () => {
    // The desktop sidebar carries SignOutButton but is hidden md:flex, so the
    // mobile drawer MUST render its own (a distinct testId avoids colliding with
    // the sidebar's data-testid="logout" the Playwright logout helper targets).
    // The drawer body only renders once opened, which SSR can't drive, so this
    // pins the wiring statically rather than asserting the rendered button.
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "AdminMobileNav.tsx"),
      "utf8",
    );
    expect(src).toMatch(/<SignOutButton/);
  });
});
