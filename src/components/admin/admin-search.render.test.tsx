import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined }),
}));
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AdminSearchBox } from "./AdminSearchBox";
import { groupResults, flattenGroups, type SearchResult } from "@/domains/search/client";

/**
 * #188 admin search. The box's interactive states (debounced fetch,
 * keyboard loop) ride on jsdom-less SSR poorly, so the live behaviour is
 * pinned by the API harness + the pure grouping/flatten functions here;
 * this render test pins that the box mounts with its affordances (input +
 * "/" hint) and stays closed/quiet on first paint.
 */

describe("AdminSearchBox (SSR)", () => {
  it("renders the input affordance and the '/' focus hint; no panel until typed", () => {
    const html = renderToString(createElement(AdminSearchBox));
    expect(html).toContain("admin-search-input");
    // 2026-08-24: the placeholder no longer advertises "snags" — a dark feature
    // api/search.js never returns (it searches jobs + users only). Scoped to
    // the placeholder attribute so unrelated future copy can't trip it.
    expect(html).toContain('placeholder="Search jobs, people…"');
    expect(html).not.toContain("Search jobs, snags");
    // Closed on first paint — no results panel.
    expect(html).not.toContain("admin-search-panel");
    expect(html).not.toContain("No matches");
  });
});

describe("groupResults / flattenGroups (#188 pure)", () => {
  const rows: SearchResult[] = [
    { type: "user", id: "u1", label: "Sparky", url: "/employees/u1" },
    { type: "job", id: "j1", label: "Magill Rd", url: "/v2/jobs/j1" },
    { type: "snag", id: "s1", label: "Meter box", jobId: "j1", url: "/v2/jobs/j1/snags" },
    { type: "job", id: "j2", label: "Depot", url: "/v2/jobs/j2" },
  ];

  it("buckets into the fixed Jobs / Snags / People order, dropping empty groups", () => {
    const groups = groupResults(rows);
    expect(groups.map((g) => g.label)).toEqual(["Jobs", "Snags", "People"]);
    expect(groups[0]!.results.map((r) => r.id)).toEqual(["j1", "j2"]);
  });

  it("an empty result set yields no groups (UI shows 'No matches', not blank rows)", () => {
    expect(groupResults([])).toEqual([]);
  });

  it("flattenGroups walks group order — the keyboard navigation sequence", () => {
    const flat = flattenGroups(groupResults(rows));
    expect(flat.map((r) => r.id)).toEqual(["j1", "j2", "s1", "u1"]);
  });
});
