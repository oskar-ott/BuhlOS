import { describe, expect, it, vi } from "vitest";

// AdminShell pulls in AdminSidebar (usePathname) + SignOutButton (useRouter),
// so the mock covers both hooks the composed tree reads.
vi.mock("next/navigation", () => ({
  usePathname: () => "/command-centre",
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
}));
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { CommandPalette } from "./CommandPalette";
import { AdminTopbar } from "./AdminTopbar";
import { AdminShell } from "./AdminShell";
import {
  buildStaticSections,
  flattenSections,
  buildGoToCommands,
} from "./command-palette-model";

/**
 * #215 ⌘K palette. Like AdminSearchBox (#188), the live interactive states
 * (key-to-open, debounced fetch, ↑/↓/Enter loop) ride on jsdom-less SSR
 * poorly, so they're pinned by the pure model + the search domain's tested
 * helpers (command-palette-model.test.ts, admin-search.render.test.tsx). This
 * file pins the SSR contract: the palette is INVISIBLE until opened (no dead
 * chrome on first paint), the topbar advertises ONE non-interactive ⌘K hint,
 * and the shell mounts the palette while keeping its contract intact.
 */

describe("CommandPalette (SSR contract)", () => {
  it("renders nothing until opened — no palette in the first paint", () => {
    const html = renderToString(createElement(CommandPalette));
    expect(html).toBe("");
  });
});

describe("AdminTopbar ⌘K affordance (#215)", () => {
  it("shows ONE non-interactive ⌘K hint and no second search input/control", () => {
    const html = renderToString(createElement(AdminTopbar, { viewerInitials: "KB" }));
    // The hint is present (a <kbd>, aria-hidden), advertising the command layer.
    expect(html).toContain("admin-cmdk-hint");
    expect(html).toContain("⌘");
    // It is NOT a second search box or button — exactly one search input
    // (the #188 box) and no extra <button>/<input> from the hint.
    expect(html.match(/data-testid="admin-search-input"/g)).toHaveLength(1);
    expect(html).not.toContain("admin-command-input"); // palette input only when open
  });
});

describe("AdminShell mounts the palette (#215) while keeping its contract", () => {
  it("renders the shell test id and composes sidebar + topbar; palette mount throws nothing", async () => {
    // #760: AdminShell is now an async server component (it resolves the
    // viewer's owner-disabled nav flags, failing open here since next/headers
    // isn't in scope). Await the element, then render it.
    const html = renderToString(await AdminShell({ title: "Command Centre", children: "body" }));
    // check:shell-contract invariants stay intact.
    expect(html).toContain("buhlos-admin-shell");
    // Sidebar + topbar still compose (sidebar nav landmark, topbar search box).
    expect(html).toContain('aria-label="BuhlOS admin"');
    expect(html).toContain("admin-search-input");
    // Topbar ⌘K hint rides along; the palette itself stays closed (no input).
    expect(html).toContain("admin-cmdk-hint");
    expect(html).not.toContain("admin-command-input");
  });
});

/**
 * The exact command set the OPEN palette renders, pinned through the pure
 * builders the component maps 1:1 (it has no other source). This is the
 * "empty state shows Go to + Actions (+ Recent when present)" + "main routes
 * appear" + "exact hours routes" render coverage, expressed against the data
 * layer the DOM is a direct projection of.
 */
describe("Open-palette command projection (#215)", () => {
  it("empty state = Go to + Actions; the main routes are present as jumps", () => {
    const flat = flattenSections(buildStaticSections([]));
    const hrefs = flat.map((c) => c.href);
    expect(hrefs).toContain("/command-centre");
    expect(hrefs).toContain("/v2/jobs");
    expect(hrefs).toContain("/employees");
    expect(hrefs).toContain("/reports");
    // Actions are reachable in the same flat sequence.
    expect(hrefs).toContain("/v2/jobs/new"); // New job
  });

  it("the hours tab commands point at /hours, /hours/approvals, /hours/weekly EXACTLY", () => {
    const hrefs = buildGoToCommands().map((c) => c.href);
    expect(hrefs).toContain("/hours");
    expect(hrefs).toContain("/hours/approvals");
    expect(hrefs).toContain("/hours/weekly");
  });

  it("zero recents → no Recent heading in the projected sections", () => {
    const sections = buildStaticSections([]);
    expect(sections.some((s) => s.heading === "Recent")).toBe(false);
  });
});
