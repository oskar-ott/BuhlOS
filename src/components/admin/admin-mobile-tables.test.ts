import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Admin mobile-overflow contract (unit-level static guard).
 *
 * BuhlOS is the desktop/office surface, but the boss/admin must be able to
 * review and act from a phone. The recurring mobile-breakage on this surface
 * is a dense data table (or fixed-column grid) that has no horizontal-scroll
 * container: because AdminShell's <main> only scrolls vertically (and the flex
 * column is min-w-0), any child wider than the viewport forces page-wide
 * horizontal overflow and clips the right-hand Actions column off-screen.
 *
 * The 2026-06 mobile audit found three queue tables (Evidence / ITPs / Snags)
 * wrapping their <table> in `overflow-hidden` — which CLIPPED rather than
 * scrolled — and the employee register using a 6-column grid that never
 * collapsed. This test freezes the fixes and, going forward, fails if a NEW
 * admin component renders a raw <table> without putting it in an
 * `overflow-x-auto` scroll container (or adding it to the reasoned exempt
 * list). Same spirit as scripts/check-shell-contract.js — a static tripwire
 * that runs in `npm run test:unit`, no React render / mocking required.
 */

const ADMIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const read = (rel: string): string => readFileSync(join(ADMIN_DIR, rel), "utf8");

// Components that render a raw <table> / fixed-column data grid and MUST keep
// it inside a horizontal-scroll container so the page never overflows a phone.
const MOBILE_SCROLL_TABLES = [
  "EvidenceQueue.tsx",
  "ITPsQueue.tsx",
  "SnagsQueue.tsx",
  "GearRegisterClient.tsx",
  "QaStatusBoard.tsx",
];

// These three shipped wrapping their <table> in `overflow-hidden`, which
// clipped the Actions column off-screen on phones. The fix swapped the wrapper
// to overflow-x-auto; this freezes that so the clip can't return.
const PREVIOUSLY_CLIPPED = ["EvidenceQueue.tsx", "ITPsQueue.tsx", "SnagsQueue.tsx"];
const BANNED_WRAPPER = "overflow-hidden rounded-card border border-border bg-surface-raised";

// Raw <table>s intentionally OUTSIDE the mobile-scroll contract:
//  - CompliancePackView: a print/PDF deliverable (the ITP compliance pack),
//    laid out for paper, not a phone viewport.
// circuit-schedule/{ScheduleBuilder,SchedulePreview} were exempt as the
// desktop-only authoring tool; #666 wrapped both tables in overflow-x-auto
// (+ a header-wrap mobile fallback), so they now meet the contract and are
// scanned like any other admin table below.
// If you add a table here, say why; don't use it to dodge a real fix.
const TABLE_EXEMPT = new Set([
  "CompliancePackView.tsx",
]);

function walkTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsx(full));
    } else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("admin data tables stay horizontally scrollable on mobile", () => {
  it.each(MOBILE_SCROLL_TABLES)("%s keeps an overflow-x-auto scroll container", (file) => {
    expect(read(file)).toContain("overflow-x-auto");
  });

  it.each(PREVIOUSLY_CLIPPED)("%s no longer clips its table with overflow-hidden", (file) => {
    expect(read(file)).not.toContain(BANNED_WRAPPER);
  });

  it("the employee register grid scrolls (overflow-x-auto + min-w floor) instead of overflowing", () => {
    const src = read("EmployeeRegisterClient.tsx");
    expect(src).toContain("overflow-x-auto");
    // A min-width floor keeps the dense column grid legible and forces the
    // wrapper to scroll rather than crush the columns. The exact value tracks
    // the column count (widened to 760px when the Mobile column was added, §7A).
    expect(src).toMatch(/min-w-\[\d+px\]/);
  });

  it("the dense registers ship a mobile card list (sm:hidden) beside the desktop table/grid", () => {
    // Employees and Gear are the registers a boss checks on a phone: each
    // renders a stacked card list below sm and the dense column table/grid at
    // sm+ (no sideways-scrolling a 6-column grid on a phone). Freeze both.
    for (const file of ["EmployeeRegisterClient.tsx", "GearRegisterClient.tsx"]) {
      const src = read(file);
      expect(src, `${file} mobile card list`).toContain("sm:hidden");
      expect(src, `${file} desktop table/grid`).toMatch(/sm:block|sm:grid/);
    }
  });

  it("every admin component that renders a <table> wraps it in overflow-x-auto (or is exempt)", () => {
    const offenders: string[] = [];
    for (const full of walkTsx(ADMIN_DIR)) {
      const rel = relative(ADMIN_DIR, full).split("\\").join("/");
      const src = readFileSync(full, "utf8");
      if (!src.includes("<table")) continue;
      if (TABLE_EXEMPT.has(rel)) continue;
      if (!src.includes("overflow-x-auto")) offenders.push(rel);
    }
    expect(offenders, `admin <table> without an overflow-x-auto scroll container: ${offenders.join(", ")}`).toEqual([]);
  });
});
