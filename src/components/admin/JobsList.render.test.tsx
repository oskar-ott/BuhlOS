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

/** Render with explicit extra props (canBuild / newJobHref) for the §3 redesign
 *  presentation assertions. */
function renderWith(
  search: string,
  jobs: ReadonlyArray<Job>,
  props: { canBuild?: boolean; newJobHref?: string }
): string {
  nav.search = search;
  return renderToString(createElement(JobsList, { jobs, ...props }));
}

/** The pill button for `label`, asserting its pressed state. */
function pillPressed(html: string, label: string): boolean | null {
  const match = html.match(new RegExp(`aria-pressed="(true|false)"[^>]*><span>${label}</span>`));
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

describe("JobsList — Archived view", () => {
  // The page only ships archived rows for ?status=archived (jobsForStatusView).
  const WITH_ARCHIVED: ReadonlyArray<Job> = [
    ...JOBS,
    job({ id: "a1", name: "Old Arthur St", status: "archived" }),
  ];

  it("?status=archived lists the archived jobs and selects the Archived pill", () => {
    const html = render("status=archived", WITH_ARCHIVED);
    expect(html).toContain("Old Arthur St");
    expect(html).not.toContain("Smith St Rewire");
    expect(pillPressed(html, "Archived")).toBe(true);
  });

  it("'All' never shows archived rows even when they are loaded", () => {
    const html = render("", WITH_ARCHIVED);
    expect(html).not.toContain("Old Arthur St");
    expect(html).toContain("Smith St Rewire");
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
    expect(readRememberedFilters(JOBS_FILTERS_STORAGE_KEY, JOBS_FILTER_SPEC, storage)).toEqual({});
  });
});

describe("JobsList — health indicators + filter/sort (#227)", () => {
  const HEALTH_JOBS: ReadonlyArray<Job> = [
    job({
      id: "h_good",
      name: "Healthy Job",
      status: "active",
      statsEvidenceV2Pending: 0,
      statsExpiredTags: 0,
    }),
    job({ id: "h_risk", name: "Risky Job", status: "active", statsExpiredTags: 2 }),
    job({ id: "h_watch", name: "Watchful Job", status: "active", statsEvidenceV2Pending: 1 }),
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

describe("JobsList — §3 portfolio card presentation (admin redesign)", () => {
  it("renders the portfolio summary with a need-attention count from real health", () => {
    const jobs: ReadonlyArray<Job> = [
      job({ id: "a", name: "Alpha", status: "active", statsExpiredTags: 1 }), // at-risk
      job({
        id: "b",
        name: "Bravo",
        status: "active",
        statsSnagsV2Active: 0,
        statsEvidenceV2Pending: 0,
        statsItpsNeedsReview: 0,
        statsExpiredTags: 0,
      }), // good
    ];
    const html = render("", jobs);
    expect(html).toContain("2 jobs · 1 needs attention");
  });

  it("shows a real contract Value tile and the total-contract readout (admin data)", () => {
    const jobs: ReadonlyArray<Job> = [
      job({ id: "a", name: "Alpha", status: "active", contractValue: 1_500_000 }),
      job({ id: "b", name: "Bravo", status: "active", contractValue: 500_000 }),
    ];
    const html = render("", jobs);
    expect(html).toContain("$1,500,000"); // per-card Value
    expect(html).toContain("$2.00M"); // summed total-contract readout (2dp under $10M)
    // Lean-reset header row: mono "TOTAL CONTRACT … ADMIN ONLY" labels + the
    // honest priced-subset context line.
    expect(html).toContain("Total contract");
    expect(html).toContain("Admin only");
    expect(html).toContain("across 2 priced jobs");
  });

  it('shows "—" Value (never a fabricated $0) and no total readout when unpriced (LH redaction)', () => {
    const jobs: ReadonlyArray<Job> = [job({ id: "a", name: "Alpha", status: "active" })];
    const html = render("", jobs);
    expect(html).toContain("—");
    expect(html).not.toContain("Total contract");
    expect(html).not.toContain("Admin only");
  });

  it("renders the risk meter with the real health level (no fabricated 0–100 score)", () => {
    const jobs: ReadonlyArray<Job> = [
      job({ id: "a", name: "Alpha", status: "active", statsExpiredTags: 2 }),
    ];
    const html = render("", jobs);
    expect(html).toContain("Risk: At risk");
    // The prototype's numeric 0–100 risk score must NOT be reproduced.
    expect(html).not.toMatch(/Risk<\/span>[^<]*<span[^>]*>\d{1,3}<\/span>/);
  });

  it("draws the attention rule only on jobs that need you — a calm or paused job carries none", () => {
    const calm = render("", [
      job({ id: "a", name: "Alpha", status: "active", statsExpiredTags: 0, statsEvidenceV2Pending: 0 }),
      job({ id: "b", name: "Bravo", status: "on_hold", statsExpiredTags: 0, statsEvidenceV2Pending: 0 }),
    ]);
    expect(calm).not.toContain("Risk:");
    const watch = render("", [
      job({ id: "a", name: "Alpha", status: "active", statsEvidenceV2Pending: 2, statsExpiredTags: 0 }),
    ]);
    expect(watch).toContain("Risk: Watch");
  });

  it("an active job wears no phase pill (the verdict says how it's going); other phases do", () => {
    const html = render("", [
      job({ id: "a", name: "Alpha", status: "active" }),
      job({ id: "b", name: "Bravo", status: "on_hold" }),
    ]);
    const alpha = html.slice(html.indexOf(">Alpha<"), html.indexOf(">Bravo<"));
    expect(alpha).not.toContain(">Active<");
    expect(html.slice(html.indexOf(">Bravo<"))).toContain("On hold");
  });

  it("lines the desktop stats up as fixed columns, with tasks as done/total", () => {
    const html = render("", [
      job({ id: "a", name: "Alpha", status: "active", statsTasksTotal: 62, statsTasksComplete: 41 }),
    ]);
    expect(html).toContain(">41/62<");
    expect(html).toContain(">Updated<");
  });

  it("shows the +New job entry point only when a newJobHref is given (literal admin)", () => {
    const jobs: ReadonlyArray<Job> = [job({ id: "a", name: "Alpha", status: "active" })];
    const withCreate = renderWith("", jobs, { newJobHref: "/v2/jobs/new" });
    expect(withCreate).toContain('data-testid="jobs-new-job"');
    expect(withCreate).toContain("New job");
    const noCreate = render("", jobs);
    expect(noCreate).not.toContain('data-testid="jobs-new-job"');
  });

  it("keeps the +New job entry point on the zero-jobs empty state (first-job path)", () => {
    const withCreate = renderWith("", [], { newJobHref: "/v2/jobs/new" });
    expect(withCreate).toContain("No active jobs");
    expect(withCreate).toContain('data-testid="jobs-new-job"');
    const noCreate = render("", []);
    expect(noCreate).toContain("No active jobs");
    expect(noCreate).not.toContain('data-testid="jobs-new-job"');
  });

  it("shows the per-card Build chip only for admin builders", () => {
    const jobs: ReadonlyArray<Job> = [job({ id: "a", name: "Alpha", status: "active" })];
    const asBuilder = renderWith("", jobs, { canBuild: true });
    expect(asBuilder).toContain("/v2/jobs/a/builder");
    const asViewer = render("", jobs);
    expect(asViewer).not.toContain("/v2/jobs/a/builder");
  });
});

/**
 * Office on a phone (owner pull 2026-09-27): the list must read true for every
 * phase, the whole card must be the tap target, the review queue must stay one
 * tap away, and the filter chrome must not push the first job off the screen.
 */
describe("JobsList — office on a phone (2026-09-27)", () => {
  const clear = { statsEvidenceV2Pending: 0, statsExpiredTags: 0 } as const;

  it("never says 'nothing needs you' on a job that isn't running — draft, paused and finished read their phase truth", () => {
    const html = render("", [
      job({ id: "d", name: "Draft Job", status: "draft", ...clear }),
      job({ id: "h", name: "Held Job", status: "on_hold", ...clear }),
      job({
        id: "f",
        name: "Finished Job",
        status: "complete",
        completedAt: new Date(Date.now() - 6 * 86_400_000).toISOString(),
        ...clear,
      }),
    ]);
    expect(html).not.toContain("nothing needs you");
    expect(html).toContain("Not published yet");
    expect(html).toContain("Paused — nothing to review");
    expect(html).toContain("crew can log until");
  });

  it("keeps the health verdict for an active job and for any real backlog on any phase", () => {
    const html = render("", [
      job({ id: "a", name: "Live Job", status: "active", ...clear }),
      job({
        id: "h",
        name: "Held With Evidence",
        status: "on_hold",
        statsEvidenceV2Pending: 2,
        statsExpiredTags: 0,
      }),
    ]);
    expect(html).toContain("On track");
    expect(html).toContain("nothing needs you");
    expect(html).toContain("2 evidence to review");
  });

  it("the whole card is the tap target: the name link stretches over the card", () => {
    const html = render("", [job({ id: "a", name: "Alpha", status: "active", ...clear })]);
    expect(html).toMatch(
      /data-testid="job-card-link"[^>]*class="[^"]*after:absolute after:inset-0/
    );
  });

  it("the phone line carries only real facts — no dashes for what isn't there", () => {
    const html = render("", [
      job({ id: "a", name: "Alpha", status: "active", statsCrewCount: 0, ...clear }),
    ]);
    expect(html).toContain("No crew");
    expect(html).not.toContain("Tasks —");
    expect(html).not.toContain("— · ");
  });

  it("the review queue stays one tap away on the phone when evidence is waiting", () => {
    const html = render("", [
      job({
        id: "a",
        name: "Alpha",
        status: "active",
        statsEvidenceV2Pending: 3,
        statsExpiredTags: 0,
      }),
    ]);
    expect(html).toContain("Review 3 →");
    expect(html).toContain("/v2/jobs/a/evidence");
  });

  it("filter pills run as sideways strips on phones and the Archived view trails the status strip", () => {
    const html = render("", JOBS);
    expect(html).toMatch(/aria-label="Filter jobs by status"[^>]*class="[^"]*overflow-x-auto/);
    expect(html).toMatch(/aria-label="Filter jobs by health"[^>]*class="[^"]*overflow-x-auto/);
    // Header button (desktop) + strip pill (phone) — both real navigations.
    expect(html.match(/href="\/v2\/jobs\?status=archived"/g)?.length).toBe(2);
    // The ordering note rides the subline on phones.
    expect(html).toContain("sorted by risk");
  });
});
