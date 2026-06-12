import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

// The register reads filter state LIVE from the URL (soft-nav rule); the
// tests drive it by swapping what the mocked useSearchParams returns.
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/defects",
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import {
  DEFECTS_FILTERS_STORAGE_KEY,
  DEFECTS_FILTER_SPEC,
  DefectsRegister,
} from "./DefectsRegister";
import {
  readRememberedFilters,
  rememberedFilterQuery,
  type FilterStorage,
} from "@/lib/storage/remembered-filters";
import type { RegisterSnag } from "@/domains/snags/register";

/**
 * SSR smoke for /defects (#414): status markers come from the snags
 * domain's five-tone mapping (statusLabel/statusTone — no parallel
 * vocabulary), `?status=` / `?jobId=` / `?priority=` narrow the rows,
 * legacy rows carry the subtle source pill, closed/rejected rows get no
 * checkbox, and empty states name the active filters. SSR works with no
 * storage in scope at all (node env has no window — the per-device
 * memory degrades silently to URL-only). The remembered-default mount
 * branch is effect-driven and covered as pure logic via the exported
 * key + spec, same as JobsList.render.test.tsx.
 */

function snag(over: Partial<RegisterSnag> & { id: string }): RegisterSnag {
  return {
    source: "v2",
    jobId: "j1",
    jobName: "Birdwood",
    jobStatus: "active",
    title: `Snag ${over.id}`,
    status: "open",
    priority: "normal",
    areaName: null,
    assignedToName: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    evidenceCount: 0,
    ...over,
  };
}

const SNAGS: ReadonlyArray<RegisterSnag> = [
  snag({
    id: "s1",
    title: "GPO hanging off wall",
    status: "open",
    priority: "urgent",
    areaName: "Kitchen",
    evidenceCount: 2,
  }),
  snag({
    id: "s2",
    title: "Cracked plate",
    source: "legacy",
    status: "open",
    priority: "high",
    jobId: "j2",
    jobName: "Harbour",
  }),
  snag({ id: "s3", title: "Resubmitted fix", status: "resolved" }),
  snag({ id: "s4", title: "Signed-off one", status: "verified" }),
  snag({ id: "s5", title: "Done and dusted", status: "closed" }),
  snag({ id: "s6", title: "Not a defect", status: "rejected" }),
];

const JOBS = [
  { id: "j1", name: "Birdwood" },
  { id: "j2", name: "Harbour" },
];

function render(search: string, snags: ReadonlyArray<RegisterSnag> = SNAGS): string {
  nav.search = search;
  return renderToString(createElement(DefectsRegister, { snags, jobs: JOBS }));
}

/** The pill button for `label`, asserting its pressed state. */
function pillPressed(html: string, label: string): boolean | null {
  const match = html.match(
    new RegExp(`aria-pressed="(true|false)"[^>]*><span>${label}</span>`)
  );
  return match ? match[1] === "true" : null;
}

describe("DefectsRegister — default view + status markers", () => {
  it("defaults to the ACTIVE queue: open/in_progress/resolved only, both sources", () => {
    const html = render("");
    expect(html).toContain("GPO hanging off wall");
    expect(html).toContain("Cracked plate");
    expect(html).toContain("Resubmitted fix");
    expect(html).not.toContain("Signed-off one"); // verified is done
    expect(html).not.toContain("Done and dusted"); // closed
    expect(html).not.toContain("Not a defect"); // rejected waits on the worker
    expect(pillPressed(html, "Active")).toBe(true);
    expect(html).not.toContain("Reset to active");
  });

  it("derives status pills + row markers from the domain's format.ts labels", () => {
    const html = render("");
    // "In progress" with a space is the format.ts label — a hand-written
    // list would drift to "In Progress"/"in_progress". No in_progress row
    // is loaded, so its pill must NOT render (zero-count rule).
    expect(pillPressed(html, "In progress")).toBeNull();
    expect(pillPressed(html, "Resolved")).toBe(false);
    expect(pillPressed(html, "Verified")).toBe(false);
    // Row markers: urgent priority renders its label from priorityLabel.
    expect(html).toContain("Urgent");
  });

  it("marks legacy-store rows with a subtle source pill — v2 rows carry none", () => {
    const html = render("");
    expect(html.match(/>legacy</g)).toHaveLength(1); // only s2
  });

  it("rows deep-link into the owning job's snags page", () => {
    const html = render("");
    expect(html).toContain('href="/v2/jobs/j1/snags"');
    expect(html).toContain('href="/v2/jobs/j2/snags"');
  });
});

describe("DefectsRegister — URL-driven filters (#216 pattern)", () => {
  it("?status= narrows to one status and selects its pill", () => {
    const html = render("status=verified");
    expect(html).toContain("Signed-off one");
    expect(html).not.toContain("GPO hanging off wall");
    expect(pillPressed(html, "Verified")).toBe(true);
    expect(pillPressed(html, "Active")).toBe(false);
    expect(html).toContain("Reset to active");
  });

  it("?status=all shows everything including closed + rejected", () => {
    const html = render("status=all");
    expect(html).toContain("Done and dusted");
    expect(html).toContain("Not a defect");
    expect(pillPressed(html, "All")).toBe(true);
  });

  it("?jobId= and ?priority= narrow the rows", () => {
    const byJob = render("jobId=j2");
    expect(byJob).toContain("Cracked plate");
    expect(byJob).not.toContain("GPO hanging off wall");

    const byPrio = render("priority=urgent");
    expect(byPrio).toContain("GPO hanging off wall");
    expect(byPrio).not.toContain("Cracked plate");
  });

  it("ignores an unknown ?status= (stale link) and renders the default view", () => {
    const html = render("status=bogus");
    expect(html).toContain("GPO hanging off wall");
    expect(pillPressed(html, "Active")).toBe(true);
  });

  it("an empty combination names the filters, never a bare nothing-here", () => {
    const html = render("status=in_progress&priority=urgent&jobId=j2");
    expect(html).toContain("No in progress defects with urgent priority on Harbour.");
  });

  it("keeps the page-level empty state when no snags exist at all", () => {
    const html = render("", []);
    expect(html).toContain("No defects recorded");
  });
});

describe("DefectsRegister — bulk-close affordances", () => {
  it("closable rows get a labelled checkbox; closed/rejected rows do not", () => {
    const html = render("status=all");
    expect(html).toContain('aria-label="Select GPO hanging off wall on Birdwood"');
    expect(html).toContain('aria-label="Select Cracked plate on Harbour"'); // legacy closable too
    expect(html).not.toContain('aria-label="Select Done and dusted on Birdwood"');
    expect(html).not.toContain('aria-label="Select Not a defect on Birdwood"');
  });

  it("no selection → no bulk bar (the confirm step only exists once something is picked)", () => {
    const html = render("");
    expect(html).not.toContain("defects selected");
    expect(html).not.toContain("data-testid=\"defects-bulk-arm\"");
  });
});

describe("DefectsRegister — remembered default (storage mocked)", () => {
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

  it("applies the stored set only when the URL carries none of the list's params", () => {
    const storage = fakeStorage({
      [DEFECTS_FILTERS_STORAGE_KEY]: JSON.stringify({
        status: "all",
        priority: "high",
        jobId: "j2",
      }),
    });
    const stored = readRememberedFilters(DEFECTS_FILTERS_STORAGE_KEY, DEFECTS_FILTER_SPEC, storage);
    const own = Object.keys(DEFECTS_FILTER_SPEC);

    const applied = rememberedFilterQuery(new URLSearchParams(""), own, stored);
    const parsed = new URLSearchParams(applied!);
    expect(parsed.get("status")).toBe("all");
    expect(parsed.get("priority")).toBe("high");
    expect(parsed.get("jobId")).toBe("j2");

    // A URL carrying ANY of the params wins outright (shared links intact).
    expect(rememberedFilterQuery(new URLSearchParams("status=open"), own, stored)).toBeNull();
    expect(rememberedFilterQuery(new URLSearchParams("jobId=j1"), own, stored)).toBeNull();
  });

  it("drops stored values failing the live validators (retired status, junk priority)", () => {
    const storage = fakeStorage({
      [DEFECTS_FILTERS_STORAGE_KEY]: JSON.stringify({
        status: "retired_status",
        priority: "ASAP",
        jobId: "",
      }),
    });
    expect(
      readRememberedFilters(DEFECTS_FILTERS_STORAGE_KEY, DEFECTS_FILTER_SPEC, storage)
    ).toEqual({});
  });
});
