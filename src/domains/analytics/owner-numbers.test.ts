import { describe, expect, it } from "vitest";
import {
  approvalsWaitingTile,
  crewOnClockTile,
  defectsAttentionTile,
  hoursThisWeekTile,
  overContractTile,
  quotePipelineTile,
  sourceErrorTile,
  CompareWeeksResponseSchema,
  OwnerJobsResponseSchema,
  QuoteStatsResponseSchema,
  OWNER_NUMBER_IDS,
  OWNER_NUMBER_DEFINITIONS,
} from "./owner-numbers";

/**
 * #316 — one unit-tested definition per owner number (the #329 seed).
 *
 * The "populated" fixtures below are the PR's documented spot-check:
 * each is a raw endpoint payload (shape verified against the api/*.js
 * source) and the assertion states the tile value it must produce.
 */

// ── Tile 1 · hours_week ← /api/compare-weeks ───────────────────────────

const COMPARE_WEEKS_FIXTURE = {
  thisWeek: {
    weekStart: "2026-06-08",
    weekEnd: "2026-06-14",
    hours: { submittedCount: 4, submittedTotal: 31.5, approvedCount: 10, approvedTotal: 76 },
    snags: { opened: 2, resolved: 1 },
    newJobs: 1,
  },
  lastWeek: {
    weekStart: "2026-06-01",
    weekEnd: "2026-06-07",
    hours: { submittedCount: 0, submittedTotal: 0, approvedCount: 12, approvedTotal: 120 },
    snags: { opened: 0, resolved: 3 },
    newJobs: 0,
  },
  deltas: {
    hoursApprovedTotal: { abs: -44, pct: -0.367 },
    hoursSubmittedTotal: { abs: 31.5, pct: null },
    snagsOpened: { abs: 2, pct: null },
    snagsResolved: { abs: -2, pct: -0.667 },
    newJobs: { abs: 1, pct: null },
  },
};

describe("hoursThisWeekTile (/api/compare-weeks)", () => {
  it("spot-check: 31.5 submitted + 76 approved → '107.5 h', down 12.5 h vs last week's 120", () => {
    const payload = CompareWeeksResponseSchema.parse(COMPARE_WEEKS_FIXTURE);
    const tile = hoursThisWeekTile(payload, "2026-06-11");
    expect(tile.value).toBe("107.5 h");
    expect(tile.trend).toEqual({ direction: "down", label: "-12.5 h vs last week" });
    expect(tile.state).toBe("ok");
    expect(tile.drillHref).toBe("/hours");
    expect(tile.detail).toContain("last week 120 h");
    // 2026-06-11 sits inside the Mon 08 – Sun 14 window → partial-week honesty.
    expect(tile.honestNote).toContain("Week in progress");
  });

  it("renders the endpoint's pct:null case as 'New this week', never a fake %", () => {
    const payload = CompareWeeksResponseSchema.parse({
      thisWeek: {
        weekStart: "2026-06-08",
        weekEnd: "2026-06-14",
        hours: { submittedTotal: 12, approvedTotal: 0 },
      },
      lastWeek: {
        weekStart: "2026-06-01",
        weekEnd: "2026-06-07",
        hours: { submittedTotal: 0, approvedTotal: 0 },
      },
    });
    const tile = hoursThisWeekTile(payload, "2026-06-09");
    expect(tile.value).toBe("12 h");
    expect(tile.trend?.direction).toBe("up");
    expect(tile.trend?.label).toContain("New this week");
    expect(tile.trend?.label).not.toContain("%");
  });

  it("two quiet weeks → level, still ok (a zero week is a fact, not an error)", () => {
    const payload = CompareWeeksResponseSchema.parse({
      thisWeek: {
        weekStart: "2026-06-08",
        weekEnd: "2026-06-14",
        hours: { submittedTotal: 0, approvedTotal: 0 },
      },
      lastWeek: {
        weekStart: "2026-06-01",
        weekEnd: "2026-06-07",
        hours: { submittedTotal: 0, approvedTotal: 0 },
      },
    });
    const tile = hoursThisWeekTile(payload, "2026-06-08");
    expect(tile.value).toBe("0 h");
    expect(tile.trend).toEqual({ direction: "flat", label: "Level with last week" });
    expect(tile.state).toBe("ok");
  });

  it("no week-in-progress note once the viewed week has ended", () => {
    const payload = CompareWeeksResponseSchema.parse(COMPARE_WEEKS_FIXTURE);
    const tile = hoursThisWeekTile(payload, "2026-06-15");
    expect(tile.honestNote).toBeNull();
  });
});

// ── Tile 2 · approvals_waiting ← /api/time-entries?scope=approver ──────

describe("approvalsWaitingTile (/api/time-entries?scope=approver&status=submitted)", () => {
  it("spot-check: 3 submitted entries → '3', warning, drill /hours/approvals", () => {
    const payload = {
      entries: [
        { userId: "u1", date: "2026-06-10", status: "submitted" },
        { userId: "u2", date: "2026-06-10", status: "submitted" },
        { userId: "u2", date: "2026-06-11", status: "submitted" },
      ],
    };
    const tile = approvalsWaitingTile(payload);
    expect(tile.value).toBe("3");
    expect(tile.state).toBe("warning");
    expect(tile.drillHref).toBe("/hours/approvals");
    expect(tile.detail).toBe("3 submitted timesheets to review.");
  });

  it("empty queue → 0, ok (a clear queue is the good state, not a warning)", () => {
    const tile = approvalsWaitingTile({ entries: [] });
    expect(tile.value).toBe("0");
    expect(tile.state).toBe("ok");
    expect(tile.detail).toBe("No timesheets waiting for you.");
  });
});

// ── Tile 3 · crew_on_clock ← /api/today-pulse ──────────────────────────

describe("crewOnClockTile (/api/today-pulse)", () => {
  it("spot-check: crewOnSite 5 with 34 + 4.5 h logged → '5' with logged-hours detail", () => {
    const payload = {
      date: "2026-06-12",
      hours: {
        submittedCount: 4,
        submittedTotal: 34,
        approvedCount: 1,
        approvedTotal: 4.5,
        pendingCount: 4,
        draftCount: 1,
        crewOnSite: 5,
      },
    };
    const tile = crewOnClockTile(payload);
    expect(tile.value).toBe("5");
    expect(tile.label).toBe("On the clock today"); // never "on site"
    expect(tile.state).toBe("ok");
    expect(tile.detail).toBe("38.5 h submitted or approved for 2026-06-12.");
    expect(tile.drillHref).toBe("/hours");
  });

  it("zero crew → honest '0' with a not-yet note, still ok (quiet morning ≠ failure)", () => {
    const tile = crewOnClockTile({
      date: "2026-06-12",
      hours: { submittedTotal: 0, approvedTotal: 0, crewOnSite: 0 },
    });
    expect(tile.value).toBe("0");
    expect(tile.state).toBe("ok");
    expect(tile.honestNote).toBe("No hours logged for today yet.");
  });
});

// ── Tile 4 · defects_attention ← /api/snags-all?status=open ───────────

const NOW = Date.parse("2026-06-12T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

describe("defectsAttentionTile (/api/snags-all?status=open)", () => {
  it("spot-check: 1 fresh urgent + 1 stale normal + 1 fresh normal → union 2 of 3 open", () => {
    const payload = {
      snags: [
        // high-priority, NOT stale (1 day old < 3-day urgent threshold)
        { status: "open", priority: "urgent", createdAt: daysAgo(1) },
        // stale, NOT high-priority (8 days old ≥ 7-day normal threshold)
        { status: "open", priority: "normal", createdAt: daysAgo(8) },
        // neither (1 day old normal)
        { status: "open", priority: "normal", createdAt: daysAgo(1) },
      ],
    };
    const tile = defectsAttentionTile(payload, NOW);
    expect(tile.value).toBe("2");
    expect(tile.state).toBe("warning");
    expect(tile.detail).toBe("1 high-priority · 1 stale · 3 open in total.");
    expect(tile.drillHref).toBe("/defects?status=open");
  });

  it("a stale HIGH row counts once in the union (overlap never double-counts)", () => {
    const tile = defectsAttentionTile(
      { snags: [{ status: "open", priority: "high", createdAt: daysAgo(10) }] },
      NOW,
    );
    expect(tile.value).toBe("1");
    expect(tile.detail).toBe("1 high-priority · 1 stale · 1 open in total.");
  });

  it("staleness follows the admin-stats thresholds mapped to register priorities (high 3d, normal 7d, low 14d)", () => {
    const fresh = (priority: string, age: number) =>
      defectsAttentionTile(
        { snags: [{ status: "open", priority, createdAt: daysAgo(age) }] },
        NOW,
      ).value;
    expect(fresh("low", 13)).toBe("0"); // under low's 14d
    expect(fresh("low", 14)).toBe("1"); // at low's 14d
    expect(fresh("normal", 6)).toBe("0"); // under normal's 7d
    expect(fresh("normal", 7)).toBe("1"); // at normal's 7d
  });

  it("an unparseable createdAt can't prove age → not stale", () => {
    const tile = defectsAttentionTile(
      { snags: [{ status: "open", priority: "normal", createdAt: "" }] },
      NOW,
    );
    expect(tile.value).toBe("0");
    expect(tile.detail).toBe("1 open in total — none high-priority or stale.");
  });

  it("no open defects → 0, ok, honest empty note", () => {
    const tile = defectsAttentionTile({ snags: [] }, NOW);
    expect(tile.value).toBe("0");
    expect(tile.state).toBe("ok");
    expect(tile.honestNote).toBe("No open defects.");
  });
});

// ── Tile 5 · quotes_pipeline ← /api/quote-stats ────────────────────────

const QUOTE_STATS_FIXTURE = {
  asOf: "2026-06-12T00:10:00.000Z",
  total: 14,
  byStatus: {
    draft: 2,
    reviewing: 1,
    estimating: 2,
    submitted: 3,
    accepted: 1,
    won: 1,
    lost: 2,
    declined: 0,
    converted_to_job: 2,
    archived: 0,
  },
  active: 9,
  terminal: 5,
  stale: { draft: 1, reviewing: 0, estimating: 1, submitted: 2, accepted: 0 },
  conversionRate: 0.6,
};

describe("quotePipelineTile (/api/quote-stats)", () => {
  it("spot-check: active 9, stale {1,0,1,2,0} → '9' active with 4 stale, in the endpoint's vocabulary", () => {
    const payload = QuoteStatsResponseSchema.parse(QUOTE_STATS_FIXTURE);
    const tile = quotePipelineTile(payload);
    expect(tile.value).toBe("9");
    expect(tile.state).toBe("warning"); // stale quotes need a nudge
    expect(tile.detail).toBe("4 stale by the register's stage thresholds · 14 total.");
    // Verified: no quoting surface exists in the v2 shell — no dead links.
    expect(tile.drillHref).toBeNull();
    expect(tile.honestNote).toContain("No quoting surface to open yet");
  });

  it("nothing stale → ok", () => {
    const tile = quotePipelineTile(
      QuoteStatsResponseSchema.parse({
        total: 3,
        active: 3,
        stale: { draft: 0, reviewing: 0, estimating: 0, submitted: 0, accepted: 0 },
      }),
    );
    expect(tile.state).toBe("ok");
  });

  it("empty register → missing state with an honest note, never a confident '0 active'", () => {
    const tile = quotePipelineTile(
      QuoteStatsResponseSchema.parse({ total: 0, active: 0, stale: {} }),
    );
    expect(tile.state).toBe("missing");
    expect(tile.value).toBeNull();
    expect(tile.honestNote).toBe("No quotes in the register yet.");
  });
});

// ── Tile 6 · over_contract ← /api/jobs (persisted job.cashWatch) ───────

describe("overContractTile (/api/jobs persisted cashWatch)", () => {
  it("spot-check: one active job with a persisted overrun alert → '1', drill to THAT job, asOf from lastAlertedAt", () => {
    const payload = OwnerJobsResponseSchema.parse({
      jobs: [
        {
          id: "job_a",
          name: "Hilltop Rewire",
          status: "active",
          contractValue: 120000,
          cashWatch: {
            lastAlertedHash: "ab12cd34ef56ab78",
            lastAlertedAt: "2026-06-11T19:01:02.000Z",
            forecastEnd: 131400,
            contractValue: 120000,
            spent: 96100,
          },
        },
        { id: "job_b", name: "Quiet Job", status: "active", contractValue: 80000 },
        { id: "job_c", name: "Archived", status: "archived", contractValue: 50000 },
      ],
    });
    const tile = overContractTile(payload);
    expect(tile.value).toBe("1");
    expect(tile.state).toBe("warning");
    expect(tile.drillHref).toBe("/v2/jobs/job_a");
    expect(tile.detail).toBe("Hilltop Rewire — forecast $131,400 vs $120,000 contract.");
    expect(tile.asOf).toBe("Daily cash-watch · last alert 2026-06-11");
  });

  it("several alerted jobs → count with the jobs-index drill", () => {
    const mk = (id: string) => ({
      id,
      name: id,
      status: "active",
      contractValue: 10000,
      cashWatch: { lastAlertedAt: "2026-06-10T00:00:00.000Z" },
    });
    const tile = overContractTile({ jobs: [mk("a"), mk("b")].map((j) => OwnerJobsResponseSchema.shape.jobs.element.parse(j)) });
    expect(tile.value).toBe("2");
    expect(tile.drillHref).toBe("/v2/jobs");
    expect(tile.detail).toBe("2 jobs with a persisted overrun alert.");
  });

  it("contract values set, no alerts → honest 0 with cron freshness, never invented risk", () => {
    const payload = OwnerJobsResponseSchema.parse({
      jobs: [
        { id: "a", name: "A", status: "active", contractValue: 50000 },
        { id: "b", name: "B", status: "active" },
      ],
    });
    const tile = overContractTile(payload);
    expect(tile.value).toBe("0");
    expect(tile.state).toBe("ok");
    expect(tile.detail).toBe(
      "No overrun alerts on record · contract values on 1 of 2 active jobs.",
    );
    expect(tile.asOf).toBe("Updated by the daily cash-watch run.");
  });

  it("AC: no contractValue anywhere → 'No contract values set…', NEVER '$0 at risk'", () => {
    const payload = OwnerJobsResponseSchema.parse({
      jobs: [
        { id: "a", name: "A", status: "active" },
        { id: "b", name: "B", status: "active", contractValue: 0 },
      ],
    });
    const tile = overContractTile(payload);
    expect(tile.state).toBe("missing");
    expect(tile.value).toBeNull();
    expect(tile.honestNote).toBe(
      "No contract values set on active jobs — there is nothing to compare forecasts against.",
    );
    expect(tile.honestNote).not.toContain("$0");
    expect(tile.drillHref).toBe("/v2/jobs"); // where contract values get set
  });

  it("jobs without a status count as active (the cash-watch convention)", () => {
    const payload = OwnerJobsResponseSchema.parse({
      jobs: [{ id: "a", name: "A", contractValue: 1000 }],
    });
    expect(overContractTile(payload).value).toBe("0");
  });
});

// ── Per-source degradation ─────────────────────────────────────────────

describe("sourceErrorTile", () => {
  it("produces an explicit error tile that keeps the drill link where one exists", () => {
    const tile = sourceErrorTile("hours_week", "Compare-weeks API returned 500");
    expect(tile.state).toBe("error");
    expect(tile.value).toBeNull();
    expect(tile.honestNote).toBe(
      "Couldn't load this number — Compare-weeks API returned 500.",
    );
    expect(tile.drillHref).toBe("/hours");
  });

  it("covers every owner number id with a definition", () => {
    for (const id of OWNER_NUMBER_IDS) {
      const tile = sourceErrorTile(id, "boom");
      expect(tile.id).toBe(id);
      expect(tile.label).toBe(OWNER_NUMBER_DEFINITIONS[id].label);
    }
  });
});
