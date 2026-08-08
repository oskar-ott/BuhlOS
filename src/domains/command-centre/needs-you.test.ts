import { describe, expect, it } from "vitest";
import {
  buildNeedsYouQueue,
  buildRightNow,
  summaryHeadline,
  type NeedsYouCounts,
} from "./needs-you";

const ZERO: NeedsYouCounts = {
  rejected: 0,
  missingDays: 0,
  noCrewJobs: 0,
  pending: 0,
  evidence: 0,
};

describe("summaryHeadline", () => {
  it("joins the blocking and pending clauses (design sentence)", () => {
    expect(summaryHeadline({ rejected: 1, missingDays: 1, pending: 5 })).toBe(
      "2 things are holding up pay this week, and 5 days are waiting on your approval.",
    );
  });

  it("singularises both clauses", () => {
    expect(summaryHeadline({ rejected: 1, missingDays: 0, pending: 1 })).toBe(
      "1 thing is holding up pay this week, and 1 day is waiting on your approval.",
    );
  });

  it("drops the pending clause at pending=0", () => {
    expect(summaryHeadline({ rejected: 2, missingDays: 0, pending: 0 })).toBe(
      "2 things are holding up pay this week.",
    );
  });

  it("claims 'Nothing is blocked' only when BOTH blocking sources loaded", () => {
    expect(summaryHeadline({ rejected: 0, missingDays: 0, pending: 3 })).toBe(
      "Nothing is blocked — 3 days are waiting on your approval.",
    );
    // Missing-hours source failed → no all-clear claim, pending stands alone.
    expect(summaryHeadline({ rejected: 0, missingDays: null, pending: 3 })).toBe(
      "3 days are waiting on your approval.",
    );
  });

  it("omits a FAILED source's clause instead of counting it as 0", () => {
    // Pending failed: blocking clause only — no fabricated "0 days waiting".
    expect(summaryHeadline({ rejected: 2, missingDays: 1, pending: null })).toBe(
      "3 things are holding up pay this week.",
    );
    // One blocking source failed but the other has real work: honest partial sum.
    expect(summaryHeadline({ rejected: null, missingDays: 2, pending: 0 })).toBe(
      "2 things are holding up pay this week.",
    );
  });

  it("gives the full all-clear only when every source loaded at zero", () => {
    expect(summaryHeadline({ rejected: 0, missingDays: 0, pending: 0 })).toBe(
      "Nothing needs you. Every day this week is approved and no crew is waiting.",
    );
  });

  it("says nothing (null) when the remaining sources failed — never a false all-clear", () => {
    expect(summaryHeadline({ rejected: null, missingDays: null, pending: null })).toBeNull();
    expect(summaryHeadline({ rejected: 0, missingDays: 0, pending: null })).toBeNull();
    expect(summaryHeadline({ rejected: null, missingDays: 0, pending: 0 })).toBeNull();
  });
});

describe("buildNeedsYouQueue", () => {
  it("orders rows blockers-first and drops zero counts", () => {
    const rows = buildNeedsYouQueue({
      rejected: 1,
      missingDays: 0, // dropped
      noCrewJobs: 2,
      pending: 5,
      evidence: 7,
    });
    expect(rows.map((r) => r.key)).toEqual(["rejected", "no-crew", "pending", "evidence"]);
    expect(rows.map((r) => r.tone)).toEqual(["block", "block", "wait", "calm"]);
  });

  it("routes each core row to its owning surface", () => {
    const rows = buildNeedsYouQueue({
      rejected: 1,
      missingDays: 1,
      noCrewJobs: 1,
      pending: 1,
      evidence: 1,
    });
    expect(rows.map((r) => [r.key, r.cta, r.href])).toEqual([
      ["rejected", "Approve", "/hours/approvals"],
      ["missing", "Hours", "/hours/weekly"],
      ["no-crew", "Jobs", "/v2/jobs"],
      ["pending", "Approve", "/hours/approvals"],
      ["evidence", "Jobs", "/v2/jobs"],
    ]);
  });

  it("pluralises row titles by count", () => {
    const one = buildNeedsYouQueue({ ...ZERO, rejected: 1, pending: 1 });
    expect(one.find((r) => r.key === "rejected")?.title).toBe("Rejected day to re-submit");
    expect(one.find((r) => r.key === "pending")?.title).toBe("Day waiting on your approval");
    const many = buildNeedsYouQueue({ ...ZERO, rejected: 3, pending: 2 });
    expect(many.find((r) => r.key === "rejected")?.title).toBe("Rejected days to re-submit");
    expect(many.find((r) => r.key === "pending")?.title).toBe("Days waiting on your approval");
  });

  it("returns an empty queue on an all-zero day (page renders the all-clear card)", () => {
    expect(buildNeedsYouQueue(ZERO)).toEqual([]);
  });
});

describe("buildRightNow (weekly-first, owner directive 2026-08-08)", () => {
  it("renders the three WEEK tiles with a roster suffix when a denominator exists", () => {
    const tiles = buildRightNow({
      crewLoggedThisWeek: 4,
      rosterTotal: 5,
      weekHoursLabel: "148h 30m",
      jobsThisWeek: 4,
    });
    expect(tiles).toEqual([
      { key: "crew-week", value: "4", suffix: "/5", label: "workers logged this week" },
      { key: "logged-week", value: "148h 30m", label: "hours this week" },
      { key: "jobs-week", value: "4", label: "jobs worked this week" },
    ]);
  });

  it("renders '—' for unloaded signals and omits an unproven roster suffix", () => {
    const tiles = buildRightNow({
      crewLoggedThisWeek: null,
      rosterTotal: 5,
      weekHoursLabel: null,
      jobsThisWeek: null,
    });
    expect(tiles.map((t) => t.value)).toEqual(["—", "—", "—"]);
    expect(tiles[0]?.suffix).toBeUndefined();
    // Crew loaded but roster didn't → plain count, no fabricated denominator.
    const noRoster = buildRightNow({
      crewLoggedThisWeek: 3,
      rosterTotal: null,
      weekHoursLabel: "36h",
      jobsThisWeek: 2,
    });
    expect(noRoster[0]).toEqual({
      key: "crew-week",
      value: "3",
      label: "workers logged this week",
    });
  });
});
