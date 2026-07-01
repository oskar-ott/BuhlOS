import { describe, expect, it } from "vitest";
import { NAV_GROUPS, ALL_ITEMS, activeHref, visibleNavGroups, FLAGGED_ITEMS } from "./nav";

/**
 * #215 — NAV is the shared source of truth for the sidebar and the ⌘K palette.
 * AdminSidebar.render.test.tsx pins the rendered IA; this pins the data layer
 * the palette derives its "Go to" commands from, plus the longest-prefix
 * active-state logic (no unit test existed before the extraction).
 */

describe("NAV_GROUPS / ALL_ITEMS (#215 shared source)", () => {
  it("flattens every group item into ALL_ITEMS in group order", () => {
    const flat = NAV_GROUPS.flatMap((g) => g.items);
    expect(ALL_ITEMS.map((i) => i.href)).toEqual(flat.map((i) => i.href));
  });

  it("carries every live surface, grouped, with no duplicate destinations", () => {
    expect(NAV_GROUPS.map((g) => g.heading)).toEqual([
      "Today",
      "Jobs",
      "Hours",
      "People & gear",
      "Company",
    ]);
    const hrefs = ALL_ITEMS.map((i) => i.href);
    expect(hrefs).toEqual([
      "/command-centre",
      "/observations",
      "/material-requests",
      "/expenses",
      "/v2/jobs",
      "/v2/quotes",
      "/defects",
      "/itp-templates",
      "/qa",
      "/v2/dayworks",
      "/hours",
      "/employees",
      "/gear",
      "/reports",
    ]);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("every item has a non-empty label and at least one activeFor prefix", () => {
    for (const item of ALL_ITEMS) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.activeFor.length).toBeGreaterThan(0);
    }
  });
});

describe("activeHref (#215 longest-prefix)", () => {
  it("matches an exact route to its own item", () => {
    expect(activeHref("/command-centre")).toBe("/command-centre");
    expect(activeHref("/reports")).toBe("/reports");
    expect(activeHref("/qa")).toBe("/qa");
  });

  it("keeps the single Hours item active across all three hours routes (#415)", () => {
    expect(activeHref("/hours")).toBe("/hours");
    expect(activeHref("/hours/approvals")).toBe("/hours");
    expect(activeHref("/hours/weekly")).toBe("/hours");
  });

  it("a deeper job path keeps Jobs active", () => {
    expect(activeHref("/v2/jobs/j1/itps")).toBe("/v2/jobs");
  });

  it("distinct /v2 prefixes never steal each other (longest-prefix, not first-match)", () => {
    // /v2/quotes/<id> must resolve to Quotes, not Jobs — they share no prefix
    // beyond /v2, which isn't an activeFor, so both must stay independent.
    expect(activeHref("/v2/quotes/qv2_abc123")).toBe("/v2/quotes");
    expect(activeHref("/v2/jobs/j1")).toBe("/v2/jobs");
  });

  it("returns null when nothing matches (e.g. /settings — a footer link, not a nav item)", () => {
    expect(activeHref("/settings/notifications")).toBeNull();
    expect(activeHref("/")).toBeNull();
    expect(activeHref("/totally-unknown")).toBeNull();
  });

  it("does not treat a sibling string-prefix as a path match (/hours-foo ≠ /hours)", () => {
    // startsWith uses a trailing slash, so /hoursful or /hours-x is NOT under /hours.
    expect(activeHref("/hoursful")).toBeNull();
    expect(activeHref("/reports-archive")).toBeNull();
  });
});

describe("visibleNavGroups (#760 owner feature-control)", () => {
  it("returns every group unchanged when nothing is hidden", () => {
    expect(visibleNavGroups()).toBe(NAV_GROUPS);
    expect(visibleNavGroups([])).toBe(NAV_GROUPS);
  });

  it("drops the hidden hrefs and keeps the rest", () => {
    const groups = visibleNavGroups(["/reports", "/gear"]);
    const hrefs = groups.flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).not.toContain("/reports");
    expect(hrefs).not.toContain("/gear");
    expect(hrefs).toContain("/v2/jobs");
    expect(hrefs).toContain("/command-centre");
  });

  it("drops a whole group when all its items are hidden", () => {
    // Company only holds /reports; hiding it removes the group entirely.
    const groups = visibleNavGroups(["/reports"]);
    expect(groups.some((g) => g.heading === "Company")).toBe(false);
    // People & gear still shows Employees when only Gear is hidden.
    const peopleGear = visibleNavGroups(["/gear"]).find((g) => g.heading === "People & gear");
    expect(peopleGear?.items.map((i) => i.href)).toEqual(["/employees"]);
  });

  it("never mutates the source NAV_GROUPS", () => {
    const before = NAV_GROUPS.flatMap((g) => g.items).length;
    visibleNavGroups(["/reports", "/gear", "/v2/jobs"]);
    expect(NAV_GROUPS.flatMap((g) => g.items).length).toBe(before);
  });
});

describe("FLAGGED_ITEMS (#760)", () => {
  it("pairs every flag-gated nav item with its flag; Command centre is never gated", () => {
    const byHref = Object.fromEntries(FLAGGED_ITEMS.map((f) => [f.href, f.flag]));
    expect(byHref["/v2/jobs"]).toBe("jobs");
    expect(byHref["/hours"]).toBe("hours");
    expect(byHref["/observations"]).toBe("observations_inbox");
    expect(byHref["/itp-templates"]).toBe("itp");
    expect(byHref["/qa"]).toBe("itp"); // QA status rides the same ITP kill-switch
    // Command centre must stay reachable so the owner can't self-lock.
    expect(byHref["/command-centre"]).toBeUndefined();
  });
});
