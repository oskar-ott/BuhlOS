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
      ["missing", "Hours", "/hours"],
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

describe("buildRightNow", () => {
  it("renders the three tiles with a roster suffix when a denominator exists", () => {
    const tiles = buildRightNow({
      crewOnSite: 4,
      rosterTotal: 5,
      loggedHoursLabel: "18h 20m",
      jobsLiveToday: 4,
    });
    expect(tiles).toEqual([
      { key: "clock", value: "4", suffix: "/5", label: "on the clock" },
      { key: "logged", value: "18h 20m", label: "logged today" },
      { key: "jobs", value: "4", label: "jobs live today" },
    ]);
  });

  it("renders '—' for unloaded signals and omits an unproven roster suffix", () => {
    const tiles = buildRightNow({
      crewOnSite: null,
      rosterTotal: 5,
      loggedHoursLabel: null,
      jobsLiveToday: null,
    });
    expect(tiles.map((t) => t.value)).toEqual(["—", "—", "—"]);
    expect(tiles[0]?.suffix).toBeUndefined();
    // Crew loaded but roster didn't → plain count, no fabricated denominator.
    const noRoster = buildRightNow({
      crewOnSite: 3,
      rosterTotal: null,
      loggedHoursLabel: "6h",
      jobsLiveToday: 2,
    });
    expect(noRoster[0]).toEqual({ key: "clock", value: "3", label: "on the clock" });
  });
});
