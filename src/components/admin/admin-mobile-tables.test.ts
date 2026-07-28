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
  "GearRegisterClient.tsx",
];

// This one shipped wrapping its <table> in `overflow-hidden`, which clipped the
// Actions column off-screen on phones. The fix swapped the wrapper to
// overflow-x-auto; this freezes that so the clip can't return.
const PREVIOUSLY_CLIPPED = ["EvidenceQueue.tsx"];
const BANNED_WRAPPER = "overflow-hidden rounded-card border border-border bg-surface-raised";

// Raw <table>s intentionally OUTSIDE the mobile-scroll contract. If you add a
// table here, say why; don't use it to dodge a real fix. (The 2026-07-27 gut
// deleted every previous exemption with its feature.)
const TABLE_EXEMPT = new Set<string>([]);

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

  it("the employee register never reintroduces a fixed-width column grid (lean reset)", () => {
    // The lean-reset register (replica lines 429-442) is a single-column row
    // list — avatar · name · pills — that truncates instead of overflowing, so
    // it needs NO horizontal-scroll container. Freeze that: a min-width floor
    // or a fixed column template would mean the dense grid crept back without
    // a scroll wrapper.
    const src = read("EmployeeRegisterClient.tsx");
    expect(src).not.toMatch(/min-w-\[\d+px\]/);
    expect(src).not.toContain("grid-cols-[");
  });

  it("the dense gear register ships a mobile card list (sm:hidden) beside the desktop table/grid", () => {
    // Gear keeps the dense column grid, so it still needs the stacked card
    // list below sm and the grid at sm+ (no sideways-scrolling on a phone).
    const src = read("GearRegisterClient.tsx");
    expect(src, "GearRegisterClient.tsx mobile card list").toContain("sm:hidden");
    expect(src, "GearRegisterClient.tsx desktop table/grid").toMatch(/sm:block|sm:grid/);
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
