/* eslint-disable no-restricted-syntax --
 * This is the test that ENFORCES the deprecated-naming ban, so it must
 * contain the banned literals ("Site Office", the kept `buhl-site-office-*`
 * key) to verify the detector and surfaces. The same `no-restricted-syntax`
 * rule rightly bans these in product code under src/; this test is the one
 * sanctioned place they appear.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * Deprecated product-naming + legacy-estate guard (unit level).
 *
 * The product presents as ONE brand: **BuhlOS** on every user-visible
 * surface. "Phil" is the internal name of the field surface (code, routes,
 * docs) and a reserved future brand — it must NOT appear in user-visible
 * copy. See src/naming/brand.ts.
 * "Site Office" and "Switchboard" (as a product) are deprecated names —
 * see docs/architecture/00-rebuild-non-negotiables.md and
 * docs/route-ownership.md §2/§7.
 *
 * The legacy-interface cutover DELETED the legacy static estate
 * (login.html, phil.html, my-day.html, the /admin/*.html suite, the
 * dev/site-office gallery). This test locks both halves of that state:
 *   1. the deleted surfaces stay deleted (resurrecting one fails CI), and
 *   2. the files still served from public/ stay free of the deprecated
 *      product name, while the electrical sense of "switchboard" (real
 *      equipment) stays legal in the domain schemas.
 *
 * It mirrors the static guards scripts/check-legacy-quarantine.js +
 * scripts/check-route-ownership.js so a regression fails in
 * `npm run test:unit` before predeploy / CI.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => readFileSync(resolve(REPO, rel), "utf8");

// "Site Office" as a product name, in any separator / case. The deprecated
// localStorage key prefix `buhl-site-office-*` is intentionally spared (the
// modern login still cleans it up from old browsers).
// Keep this in sync with SITE_OFFICE_RE in scripts/check-legacy-quarantine.js.
const SITE_OFFICE_RE = /(?<!buhl-)\bsite[ -]?office\b/i;

describe("legacy static estate stays deleted", () => {
  it.each([
    "public/login.html",
    "public/phil.html",
    "public/my-day.html",
    "public/my-gear.html",
    "public/phil-hours.html",
    "public/lh-home.html",
    "public/project.html",
    "public/install.html",
    "public/admin.html",
    "public/admin",
    "public/dev",
    "public/components",
    "public/lib",
  ])("%s does not exist", (rel) => {
    expect(existsSync(resolve(REPO, rel))).toBe(false);
  });

  it("public/ serves only the kept client portal + the PWA offline fallback", () => {
    // The legacy static estate is gone (see the cases above). The ONLY HTML
    // allowed under public/ is the kept client portal and the self-contained
    // PWA offline fallback (/offline.html, served by sw.js when a navigation
    // fails offline — #135). Any other HTML here is a legacy regression.
    const html: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (p.endsWith(".html")) html.push(p.slice(REPO.length + 1));
      }
    };
    walk(resolve(REPO, "public"));
    expect(html.sort()).toEqual(["public/client.html", "public/offline.html"]);
  });
});

describe("deprecated 'Site Office' product name", () => {
  // Every text file still served from public/ must stay clean.
  it.each(["public/client.html", "public/sw.js", "public/manifest.json", "public/theme.css", "public/css/buhlos.css"])(
    "is absent from %s",
    (rel) => {
      const offenders = read(rel)
        .split(/\r?\n/)
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(({ line }) => SITE_OFFICE_RE.test(line))
        .map(({ line, n }) => `${rel}:${n}  ${line}`);
      expect(offenders).toEqual([]);
    },
  );
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
// terminology. (The ITP scope schema was the other canonical electrical sense
// until the 2026-07-27 gut deleted the heavy ITP feature; the jobs schema's
// field module is now the one that must survive.)
describe("electrical 'switchboard' terminology is preserved", () => {
  it("the jobs schema still models the switchboards field module", () => {
    expect(read("src/domains/jobs/schema.ts")).toContain("switchboards");
  });
});

/* ----------------------------------------------------------------------- */
/* Single-brand guard: "Phil" stays out of user-visible copy               */
/* ----------------------------------------------------------------------- */

// The brand constant is canon; the CJS mirror feeds the email templates.
import { FIELD_APP_NAME, OFFICE_APP_NAME } from "./brand";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);

describe("single-brand: BuhlOS everywhere users look", () => {
  it("brand.ts and api/_lib/brand.js stay in sync", () => {
    const cjs = requireCjs(resolve(REPO, "api/_lib/brand.js")) as {
      FIELD_APP_NAME: string;
      OFFICE_APP_NAME: string;
    };
    expect(cjs.FIELD_APP_NAME).toBe(FIELD_APP_NAME);
    expect(cjs.OFFICE_APP_NAME).toBe(OFFICE_APP_NAME);
  });

  it("this version ships as BuhlOS (Phil is reserved, not live)", () => {
    expect(FIELD_APP_NAME).toBe("BuhlOS");
    expect(OFFICE_APP_NAME).toBe("BuhlOS");
  });

  it("the PWA manifest presents as BuhlOS", () => {
    const manifest = JSON.parse(read("public/manifest.json")) as { name: string; short_name: string };
    expect(manifest.name).toBe(FIELD_APP_NAME);
    expect(manifest.short_name).toBe(FIELD_APP_NAME);
  });

  it("every rendered invite email is Phil-free", () => {
    const T = requireCjs(resolve(REPO, "api/_lib/email-templates.js")) as Record<
      string,
      (ctx: Record<string, unknown>) => { subject: string; html: string; text: string }
    >;
    const ctx = {
      firstName: "Liam", lastName: "Marriott", companyName: "bühl electrical",
      roleLabel: "apprentice", ctaUrl: "https://buhlos.com/phil/invite/T",
      expiresText: "This invite expires 11 Jun 2026", adminName: "Oskar",
      adminPhone: "0400 000 000", timeText: "7:46am", jobText: "Magill Rd",
      loginUrl: "https://buhlos.com/v2/login",
      buhlosUrl: "https://buhlos.com/employees",
    };
    for (const kind of ["inviteEmail", "resendEmail", "expiredReplacementEmail", "acceptedNotificationEmail", "welcomeEmail"]) {
      const render = T[kind];
      if (!render) throw new Error(`missing template export ${kind}`);
      const msg = render(ctx);
      // The CTA URL legitimately contains /phil/ (routes are sacred); strip
      // URLs before asserting the visible words are Phil-free.
      for (const part of [msg.subject, msg.html, msg.text]) {
        const visible = part.replace(/https?:\/\/\S+/g, "");
        expect(visible, `${kind} leaks the Phil brand`).not.toMatch(/\bPhil\b/);
      }
    }
  });
});
