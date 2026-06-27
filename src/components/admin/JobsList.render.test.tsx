import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// The list reads filter state LIVE from the URL (soft-nav rule); the tests
// drive it by swapping what the mocked useSearchParams returns per render.
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/v2/jobs",
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import { JOBS_FILTERS_STORAGE_KEY, JOBS_FILTER_SPEC, JobsList } from "./JobsList";
import {
  readRememberedFilters,
  rememberedFilterQuery,
  type FilterStorage,
} from "@/lib/storage/remembered-filters";
import type { Job } from "@/domains/jobs/types";

/**
 * SSR smoke for the #216 URL-driven filters: pills derive labels from
 * src/domains/jobs/format.ts (no parallel vocabulary), `?status=` + `?q=`
 * narrow the rows, empty states name the active filters, and SSR works with
 * no storage in scope at all (node env has no window — the per-device
 * memory degrades silently to URL-only, which is exactly the contract).
 * The remembered-default mount branch is effect-driven and covered as pure
 * logic in src/lib/storage/remembered-filters.test.ts.
 */

function job(over: Partial<Job> & { id: string; name: string }): Job {
  return { ...over } as Job;
}

const JOBS: ReadonlyArray<Job> = [
  job({ id: "j1", name: "Smith St Rewire", status: "active", siteAddress: "12 Smith St" }),
  job({ id: "j2", name: "Harbour Tower", status: "on_hold" }),
  job({ id: "j3", name: "Legacy Cottage" }), // no status field → filters as active
];

function render(search: string, jobs: ReadonlyArray<Job> = JOBS): string {
  nav.search = search;
  return renderToString(createElement(JobsList, { jobs }));
}

/** The pill button for `label`, asserting its pressed state. */
function pillPressed(html: string, label: string): boolean | null {
  const match = html.match(
    new RegExp(`aria-pressed="(true|false)"[^>]*><span>${label}</span>`)
  );
  return match ? match[1] === "true" : null;
}

describe("JobsList — status pills (#216)", () => {
  it("renders every loaded job and an 'All' pill selected when the URL is clean", () => {
    const html = render("");
    expect(html).toContain("Smith St Rewire");
    expect(html).toContain("Harbour Tower");
    expect(html).toContain("Legacy Cottage");
    expect(pillPressed(html, "All")).toBe(true);
    expect(html).not.toContain("Reset to all");
  });

  it("derives pill labels from format.ts and hides zero-count statuses", () => {
    const html = render("");
    // "On hold" (with the space) is the format.ts label — a hand-written
    // list would drift to "On Hold" / "on_hold".
    expect(pillPressed(html, "On hold")).toBe(false);
    // No complete/draft jobs are loaded → no dead pills for them.
    expect(pillPressed(html, "Complete")).toBeNull();
    expect(pillPressed(html, "Draft")).toBeNull();
  });

  it("?status= narrows the rows and selects the pill", () => {
    const html = render("status=on_hold");
    expect(html).toContain("Harbour Tower");
    expect(html).not.toContain("Smith St Rewire");
    expect(pillPressed(html, "On hold")).toBe(true);
    expect(pillPressed(html, "All")).toBe(false);
    expect(html).toContain("Reset to all");
  });

  it("treats a job with no status field as active (format.ts parity)", () => {
    const html = render("status=active");
    expect(html).toContain("Smith St Rewire");
    expect(html).toContain("Legacy Cottage");
    expect(html).not.toContain("Harbour Tower");
  });

  it("a deep link to a status with no jobs still shows its pill + a named empty state", () => {
    const html = render("status=draft");
    expect(pillPressed(html, "Draft")).toBe(true);
    expect(html).toContain("No draft jobs in this list.");
  });

  it("ignores an unknown ?status= (stale link) and renders unfiltered", () => {
    const html = render("status=bogus");
    expect(html).toContain("Smith St Rewire");
    expect(html).toContain("Harbour Tower");
    expect(pillPressed(html, "All")).toBe(true);
  });
});

describe("JobsList — search + combinations (#216)", () => {
  it("?q= filters by name/address and pre-fills the search box", () => {
    const html = render("q=smith");
    expect(html).toContain("Smith St Rewire");
    expect(html).not.toContain("Harbour Tower");
    expect(html).toMatch(/value="smith"/);
  });

  it("?status= and ?q= compose", () => {
    const html = render("status=active&q=cottage");
    expect(html).toContain("Legacy Cottage");
    expect(html).not.toContain("Smith St Rewire");
  });

  it("an empty combination names BOTH filters, never a bare nothing-here", () => {
    const html = render("status=on_hold&q=cottage");
    expect(html).toContain("No on hold jobs match “cottage”.");
  });

  it("keeps the page-level empty state when no jobs are loaded at all", () => {
    const html = render("", []);
    expect(html).toContain("No active jobs");
  });
});

describe("JobsList — remembered default (storage mocked)", () => {
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

  // The mount application is a useEffect (never runs under renderToString);
  // its decision logic is pure and asserted here through the list's REAL
  // storage key + validators — the "applies only when the URL is clean"
  // branch.
  it("applies the stored set only when the URL carries neither filter param", () => {
    const storage = fakeStorage({
      [JOBS_FILTERS_STORAGE_KEY]: JSON.stringify({ status: "on_hold", q: "tower" }),
    });
    const stored = readRememberedFilters(JOBS_FILTERS_STORAGE_KEY, JOBS_FILTER_SPEC, storage);
    const own = Object.keys(JOBS_FILTER_SPEC);

    const applied = rememberedFilterQuery(new URLSearchParams(""), own, stored);
    const parsed = new URLSearchParams(applied!);
    expect(parsed.get("status")).toBe("on_hold");
    expect(parsed.get("q")).toBe("tower");

    // A URL carrying EITHER param wins outright (shared links stay intact).
    expect(rememberedFilterQuery(new URLSearchParams("q=smith"), own, stored)).toBeNull();
    expect(rememberedFilterQuery(new URLSearchParams("status=active"), own, stored)).toBeNull();
  });

  it("drops stored values failing the live validators (status outside format.ts, absurd q)", () => {
    const storage = fakeStorage({
      [JOBS_FILTERS_STORAGE_KEY]: JSON.stringify({
        status: "retired_status",
        q: "x".repeat(201),
      }),
    });
    expect(readRememberedFilters(JOBS_FILTERS_STORAGE_KEY, JOBS_FILTER_SPEC, storage)).toEqual(
      {}
    );
  });
});

describe("JobsList — health indicators + filter/sort (#227)", () => {
  const HEALTH_JOBS: ReadonlyArray<Job> = [
    job({ id: "h_good", name: "Healthy Job", status: "active", statsSnagsV2Active: 0, statsEvidenceV2Pending: 0, statsItpsNeedsReview: 0, statsExpiredTags: 0 }),
    job({ id: "h_risk", name: "Risky Job", status: "active", statsExpiredTags: 2 }),
    job({ id: "h_watch", name: "Watchful Job", status: "active", statsSnagsV2Active: 1 }),
  ];

  it("renders a per-row health badge incl. an At-risk pill and an On-track pill", () => {
    const html = render("", HEALTH_JOBS);
    expect(html).toContain("At risk");
    expect(html).toContain("On track");
    expect(html).toContain("Watch");
  });

  it("sorts trouble first — needs-me-first triage", () => {
    const html = render("", HEALTH_JOBS);
    expect(html.indexOf("Risky Job")).toBeLessThan(html.indexOf("Watchful Job"));
    expect(html.indexOf("Watchful Job")).toBeLessThan(html.indexOf("Healthy Job"));
  });

  it("?health=at-risk narrows to at-risk jobs", () => {
    const html = render("?health=at-risk", HEALTH_JOBS);
    expect(html).toContain("Risky Job");
    expect(html).not.toContain("Healthy Job");
    expect(html).not.toContain("Watchful Job");
  });
});
