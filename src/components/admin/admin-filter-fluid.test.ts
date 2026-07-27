import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * Admin filter-bar fluid-select contract (#661) — a static source guard, the
 * same spirit as admin-mobile-tables.test.ts (#660).
 *
 * The admin inbox filter selects used a fixed `min-w-[8–10rem]` with an
 * UNSCOPED `max-w-[11rem]`, so at 320–375px the filter row felt cramped. The
 * fix makes each select a full-width stacked row on phones and restores its
 * fixed min-width at sm+ (`w-full min-w-0 … sm:w-auto sm:min-w-[…]`), scoping
 * any width cap to sm+. This test freezes that contract: each filter select
 * carries `w-full` + `sm:w-auto` and no longer carries an UNSCOPED
 * `max-w-[11rem]` (the `sm:max-w-[11rem]` cap is fine). No render/mocking —
 * a string tripwire that runs in test:unit.
 */
const ADMIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const read = (rel: string): string => readFileSync(join(ADMIN_DIR, rel), "utf8");

// Each file → the marker strings that uniquely identify its filter select(s).
const FILTER_SELECTS: ReadonlyArray<{ file: string; floors: string[] }> = [
  { file: "HoursFilterBar.tsx", floors: ["sm:min-w-[10rem]"] },
  { file: "EvidenceFilterBar.tsx", floors: ["sm:min-w-[10rem]"] },
];

describe("admin filter bars are fluid on phones (#661)", () => {
  for (const { file, floors } of FILTER_SELECTS) {
    it(`${file}: the filter select is w-full on phones, fixed-width at sm+`, () => {
      const src = read(file);
      // The fluid class fragment is present on the filter select line.
      for (const floor of floors) {
        const line = src
          .split("\n")
          .find((l) => l.includes(floor) && l.includes("rounded-card"));
        expect(line, `expected a select line with ${floor}`).toBeTruthy();
        expect(line!).toContain("w-full");
        expect(line!).toContain("sm:w-auto");
        // No UNSCOPED max-w-[11rem] (the sm:-prefixed cap is allowed).
        expect(line!.replace(/sm:max-w-\[11rem\]/g, "")).not.toContain("max-w-[11rem]");
      }
    });
  }

});
