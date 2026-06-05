/* eslint-disable no-restricted-syntax --
 * This is the test that ENFORCES the deprecated-naming ban, so it must
 * contain the banned literals ("Site Office", the kept `buhl-site-office-*`
 * key, the `/dev/site-office` path) to verify the detector and surfaces.
 * The same `no-restricted-syntax` rule rightly bans these in product code
 * under src/; this test is the one sanctioned place they appear.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Deprecated product-naming guard (unit level).
 *
 * The product surfaces are **BuhlOS** (office / admin) and **Phil** (field).
 * "Site Office" and "Switchboard" (as a product) are deprecated names —
 * see docs/architecture/00-rebuild-non-negotiables.md and
 * docs/route-ownership.md §2/§7/§9.
 *
 * The field-readiness audit found the deprecated "Site Office" name still
 * rendering in the active *legacy* surfaces (public/phil.html, the LH home,
 * the shared admin shell). This test locks those surfaces free of it and
 * proves the electrical sense of "switchboard" (the real equipment) is
 * never banned. It mirrors the static guard scripts/check-route-ownership.js
 * so a regression fails in `npm run test:unit` before predeploy / CI.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => readFileSync(resolve(REPO, rel), "utf8");

// "Site Office" as a product name, in any separator / case. The deprecated
// localStorage key prefix `buhl-site-office-*` is intentionally spared (it
// is kept so existing prefs aren't orphaned; the modern app cleans it up).
// Keep this in sync with SITE_OFFICE_RE in scripts/check-route-ownership.js.
const SITE_OFFICE_RE = /(?<!buhl-)\bsite[ -]?office\b/i;

// The active, user-facing production legacy surfaces (route-ownership §6).
const ACTIVE_SURFACES = [
  "public/login.html",
  "public/phil.html",
  "public/lh-home.html",
  "public/admin/_shell.js",
];

describe("deprecated 'Site Office' product name", () => {
  it.each(ACTIVE_SURFACES)("is absent from %s", (rel) => {
    const offenders = read(rel)
      .split(/\r?\n/)
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => SITE_OFFICE_RE.test(line))
      .map(({ line, n }) => `${rel}:${n}  ${line}`);
    expect(offenders).toEqual([]);
  });
});

describe("Site Office detector semantics", () => {
  it("catches the product name in every separator / case", () => {
    for (const s of [
      "Site Office",
      "site office",
      "Site-Office",
      "SiteOffice",
      "Clients use the Site Office portal.",
      "Switch to site office view",
    ]) {
      expect(SITE_OFFICE_RE.test(s)).toBe(true);
    }
  });

  it("spares the kept localStorage key prefix buhl-site-office-*", () => {
    for (const s of [
      "const TWEAK_KEY = 'buhl-site-office-tweaks';",
      "localStorage.setItem('buhl-site-office-density','compact')",
    ]) {
      expect(SITE_OFFICE_RE.test(s)).toBe(false);
    }
  });
});

/**
 * The Switchboard product-name ban (scripts/check-route-ownership.js) runs
 * `/\bswitchboard\b/i` against the modern nav's *controlled vocabulary*
 * only, so it catches the singular product name but never the electrical
 * register. Lock that intended semantics here.
 */
const SWITCHBOARD_NAV_RE = /\bswitchboard\b/i;
describe("'Switchboard' nav-label detector spares the electrical sense", () => {
  it("catches the singular deprecated product name", () => {
    expect(SWITCHBOARD_NAV_RE.test("Switchboard")).toBe(true);
  });
  it("spares the plural electrical register (word boundary)", () => {
    expect(SWITCHBOARD_NAV_RE.test("Switchboards")).toBe(false);
  });
});

// Sanity: removing the product name must not nuke real electrical
// terminology. These are the equipment/scope senses we must preserve.
describe("electrical 'switchboard' terminology is preserved", () => {
  it("admin mock data still references the electrical switchboard stage", () => {
    expect(/switchboard/i.test(read("public/admin/admin-data.js"))).toBe(true);
  });
  it("the ITP scope schema still defines the 'switchboard' scope", () => {
    expect(read("src/domains/itp/schema.ts")).toContain('"switchboard"');
  });
});

// The deprecated /dev/site-office surface can't be renamed in a naming PR
// (route-ownership §12 step 5), so it must be visibly quarantined.
describe("deprecated /dev/site-office surface is quarantined", () => {
  it("carries a DEPRECATED marker", () => {
    expect(/deprecated/i.test(read("public/dev/site-office/components.html"))).toBe(
      true,
    );
  });
});
