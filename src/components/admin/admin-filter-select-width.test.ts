import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * Admin filter-<select> width contract (unit-level static guard).
 *
 * Native <select>s size themselves to their WIDEST <option>. The admin filter
 * bars build their options from live data (job names, worker names), so a
 * single verbose value — e.g. a "QA_SEED_FIELD_VALIDATION…" seed job — blew the
 * /command-centre Exceptions "Job" filter to 425px on a phone, which pushed
 * <main> to 462px and scrolled the WHOLE page sideways (every card clipped on
 * the left). It only reproduces with real data + real fonts, so static reading
 * and a short-data reproduction both missed it; it was found by measuring the
 * live authed page in a 390px iframe.
 *
 * The fix: every data-option filter <select> caps its width (max-w-[…]) and is
 * allowed to shrink (min-w-0), so a long value truncates instead of widening
 * the control past the viewport. This freezes that so the regression can't
 * return. Same static-scan convention as admin-mobile-tables.test.ts /
 * scripts/check-shell-contract.js — runs in `npm run test:unit`.
 */

const ADMIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const read = (rel: string): string => readFileSync(join(ADMIN_DIR, rel), "utf8");

// Filter bars whose <select> options come from live job/worker data and so
// MUST cap the control width.
const CAPPED_FILTER_SELECTS = [
  "ExceptionsInbox.tsx",
  "HoursFilterBar.tsx",
  "EvidenceFilterBar.tsx",
];


describe("admin data-option filter selects cap their width (no page-wide overflow)", () => {
  it.each(CAPPED_FILTER_SELECTS)("%s caps its filter <select> with max-w-[11rem]", (file) => {
    expect(read(file)).toContain("max-w-[11rem]");
  });

  it("none of the capped filter selects use an UNCAPPED fixed min-w floor", () => {
    // The pre-fix pattern was a bare `min-w-[8rem]`/`min-w-[10rem]` with no
    // max — the exact shape that overflowed. After the fix those floors are
    // gated behind `sm:` (desktop only); the mobile base is min-w-0 + max-w.
    for (const file of CAPPED_FILTER_SELECTS) {
      const src = read(file);
      expect(src, `${file} still has an uncapped min-w-[8rem]`).not.toMatch(/(?<!sm:)min-w-\[8rem\]/);
      expect(src, `${file} still has an uncapped min-w-[10rem]`).not.toMatch(/(?<!sm:)min-w-\[10rem\]/);
    }
  });

  it("the topbar search box yields width to the page title on mobile", () => {
    // AdminSearchBox's `w-full` used to starve the AdminTopbar <h1> to 0px on
    // phones (title invisible). It is now capped on mobile, full at sm+.
    expect(read("AdminSearchBox.tsx")).toContain("max-w-[10rem] sm:max-w-xs");
  });
});
