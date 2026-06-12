import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// The bar reads filter state LIVE from the URL (soft-nav rule); the tests
// drive it by swapping what the mocked useSearchParams returns per render.
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/hours",
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import {
  HOURS_FILTERS_STORAGE_KEY,
  HOURS_FILTER_SPEC,
  HoursFilterBar,
} from "./HoursFilterBar";
import {
  readRememberedFilters,
  rememberedFilterQuery,
} from "@/lib/storage/remembered-filters";
import type { FilterStorage } from "@/lib/storage/remembered-filters";

/**
 * SSR smoke for the /hours filter bar (#216) plus the per-device memory
 * contract exercised against the bar's REAL storage key + validators with
 * storage mocked. The bar renders purely from the URL — node env has no
 * window/localStorage, which doubles as the degrade-silently proof: SSR
 * must never touch storage (hydration safety) and must not throw without it.
 *
 * The mount application itself is a useEffect (never runs under
 * renderToString); its decision logic is the pure rememberedFilterQuery,
 * asserted below through the bar's exported key/spec so the render test
 * covers the "remembered default applies only when the URL is clean" branch
 * end-to-end at the logic level.
 */

const PEOPLE = [
  { id: "u-ben", name: "Ben" },
  { id: "u-sam", name: "Sam" },
];

function render(search: string, personOptions = PEOPLE): string {
  nav.search = search;
  return renderToString(createElement(HoursFilterBar, { personOptions }));
}

/** The pill button for `label`, asserting its pressed state. */
function pillPressed(html: string, label: string): boolean | null {
  const match = html.match(
    new RegExp(`aria-pressed="(true|false)"[^>]*>${label}</button>`)
  );
  return match ? match[1] === "true" : null;
}

function fakeStorage(initial: Record<string, string>): FilterStorage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

describe("HoursFilterBar — render (#216)", () => {
  it("renders All + the three loaded statuses (labels from timesheets format.ts) and a person picker", () => {
    const html = render("");
    expect(pillPressed(html, "All")).toBe(true);
    expect(pillPressed(html, "Submitted")).toBe(false);
    expect(pillPressed(html, "Approved")).toBe(false);
    expect(pillPressed(html, "Rejected")).toBe(false);
    // Draft is a real entry status but not a loaded queue — never a pill.
    expect(pillPressed(html, "Draft")).toBeNull();
    expect(html).toContain("Everyone");
    expect(html).toContain("Ben");
    expect(html).not.toContain("Reset to all");
  });

  it("selects pill + person from the URL and offers Reset to all", () => {
    const html = render("status=submitted&person=u-ben&week=2026-06-08");
    expect(pillPressed(html, "Submitted")).toBe(true);
    expect(pillPressed(html, "All")).toBe(false);
    expect(html).toMatch(/<option value="u-ben" selected="">Ben<\/option>/);
    expect(html).toContain("Reset to all");
  });

  it("keeps an unknown ?person= visible as an explicit option instead of lying with 'Everyone'", () => {
    const html = render("person=u-ghost");
    expect(html).toMatch(/<option value="u-ghost" selected="">Unknown person<\/option>/);
    expect(html).toContain("Reset to all");
  });

  it("ignores an invalid ?status= (stale deep link) and renders as All", () => {
    const html = render("status=draft");
    expect(pillPressed(html, "All")).toBe(true);
    expect(html).not.toContain("Reset to all");
  });
});

describe("HoursFilterBar — remembered default (storage mocked)", () => {
  it("applies the stored set ONLY when the URL carries no filter params (week is not one)", () => {
    const storage = fakeStorage({
      [HOURS_FILTERS_STORAGE_KEY]: JSON.stringify({ status: "submitted", person: "u-ben" }),
    });
    const stored = readRememberedFilters(HOURS_FILTERS_STORAGE_KEY, HOURS_FILTER_SPEC, storage);
    const own = Object.keys(HOURS_FILTER_SPEC);

    // Clean URL (a ?week= alone is not a filter) → remembered set applies,
    // week preserved.
    const applied = rememberedFilterQuery(new URLSearchParams("week=2026-06-08"), own, stored);
    const parsed = new URLSearchParams(applied!);
    expect(parsed.get("week")).toBe("2026-06-08");
    expect(parsed.get("status")).toBe("submitted");
    expect(parsed.get("person")).toBe("u-ben");

    // URL already filtered (a shared link) → URL wins, nothing applied.
    expect(rememberedFilterQuery(new URLSearchParams("status=approved"), own, stored)).toBeNull();
    expect(rememberedFilterQuery(new URLSearchParams("person=u-sam"), own, stored)).toBeNull();
  });

  it("ignores stored values that fail the live validators (retired status, blank person)", () => {
    const storage = fakeStorage({
      [HOURS_FILTERS_STORAGE_KEY]: JSON.stringify({ status: "draft", person: " " }),
    });
    const stored = readRememberedFilters(HOURS_FILTERS_STORAGE_KEY, HOURS_FILTER_SPEC, storage);
    expect(stored).toEqual({});
    expect(
      rememberedFilterQuery(new URLSearchParams(""), Object.keys(HOURS_FILTER_SPEC), stored)
    ).toBeNull();
  });
});
