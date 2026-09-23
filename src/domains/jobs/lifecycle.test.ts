import { describe, expect, it } from "vitest";
import {
  GRACE_DAYS,
  acceptsHours,
  fieldPhaseChip,
  graceEndsAt,
  isFieldListedByDefault,
  isFieldOpenable,
  jobPhase,
  lifecycleLine,
  parseJobPhaseParam,
  phaseLabel,
  phaseTone,
} from "./lifecycle";
import { lifecycleStamps, jobMatchesQuery } from "../../../api/_lib/job-lifecycle.js";

/**
 * The job lifecycle (docs/job-lifecycle.md): one stored status, phases
 * DERIVED from `completedAt` + the clock. These pin the rules every gate and
 * screen share — the API, the crew's lists and pickers, the admin pills.
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-24T03:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

describe("jobPhase", () => {
  it("stored statuses map straight through; a missing status is active (legacy rows)", () => {
    expect(jobPhase({ status: "active" }, NOW)).toBe("active");
    expect(jobPhase({}, NOW)).toBe("active");
    expect(jobPhase({ status: null }, NOW)).toBe("active");
    expect(jobPhase({ status: "on_hold" }, NOW)).toBe("on_hold");
    expect(jobPhase({ status: "draft" }, NOW)).toBe("draft");
    expect(jobPhase({ status: "archived" }, NOW)).toBe("archived");
  });

  it("complete is 'finishing' inside the callback window and 'closed' after it", () => {
    expect(jobPhase({ status: "complete", completedAt: daysAgo(0) }, NOW)).toBe("finishing");
    expect(jobPhase({ status: "complete", completedAt: daysAgo(GRACE_DAYS - 1) }, NOW)).toBe("finishing");
    expect(jobPhase({ status: "complete", completedAt: daysAgo(GRACE_DAYS) }, NOW)).toBe("closed");
    expect(jobPhase({ status: "complete", completedAt: daysAgo(400) }, NOW)).toBe("closed");
  });

  it("complete with no / malformed completedAt reads as closed — never a silent window", () => {
    expect(jobPhase({ status: "complete" }, NOW)).toBe("closed");
    expect(jobPhase({ status: "complete", completedAt: null }, NOW)).toBe("closed");
    expect(jobPhase({ status: "complete", completedAt: "not a date" }, NOW)).toBe("closed");
    expect(graceEndsAt({ status: "complete" })).toBeNull();
  });

  it("a reopened job is judged by its status, not its old stamp", () => {
    expect(jobPhase({ status: "active", completedAt: daysAgo(100), reopenedAt: daysAgo(1) }, NOW)).toBe("active");
  });

  it("graceEndsAt is completedAt + GRACE_DAYS", () => {
    const ends = graceEndsAt({ status: "complete", completedAt: daysAgo(0) });
    expect(ends).toBe(new Date(NOW.getTime() + GRACE_DAYS * DAY).toISOString());
  });
});

describe("the crew's view", () => {
  it("default lists carry active, on hold and finishing — never closed, draft or archived", () => {
    expect(isFieldListedByDefault({ status: "active" }, NOW)).toBe(true);
    expect(isFieldListedByDefault({ status: "on_hold" }, NOW)).toBe(true);
    expect(isFieldListedByDefault({ status: "complete", completedAt: daysAgo(3) }, NOW)).toBe(true);
    expect(isFieldListedByDefault({ status: "complete", completedAt: daysAgo(31) }, NOW)).toBe(false);
    expect(isFieldListedByDefault({ status: "draft" }, NOW)).toBe(false);
    expect(isFieldListedByDefault({ status: "archived" }, NOW)).toBe(false);
  });

  it("closed jobs stay openable and take callback hours; draft/archived never", () => {
    const closed = { status: "complete", completedAt: daysAgo(90) };
    expect(isFieldOpenable(closed)).toBe(true);
    expect(acceptsHours(closed)).toBe(true);
    expect(isFieldOpenable({ status: "archived" })).toBe(false);
    expect(acceptsHours({ status: "archived" })).toBe(false);
    expect(acceptsHours({ status: "draft" })).toBe(false);
  });
});

describe("lifecycleStamps (what a status PUT writes)", () => {
  const T = "2026-09-24T03:00:00.000Z";
  it("finishing stamps completedAt and journals job.closed", () => {
    expect(lifecycleStamps({ status: "active" }, "complete", T)).toEqual({ completedAt: T, journal: "job.closed" });
    expect(lifecycleStamps({ status: "on_hold" }, "complete", T)).toEqual({ completedAt: T, journal: "job.closed" });
  });
  it("leaving complete stamps reopenedAt and journals job.reopened — to any status", () => {
    expect(lifecycleStamps({ status: "complete" }, "active", T)).toEqual({ reopenedAt: T, journal: "job.reopened" });
    expect(lifecycleStamps({ status: "complete" }, "archived", T)).toEqual({ reopenedAt: T, journal: "job.reopened" });
  });
  it("no stamp for unchanged or non-lifecycle changes", () => {
    expect(lifecycleStamps({ status: "complete" }, "complete", T)).toBeNull();
    expect(lifecycleStamps({ status: "active" }, "on_hold", T)).toBeNull();
    expect(lifecycleStamps({ status: "active" }, "archived", T)).toBeNull();
    expect(lifecycleStamps({}, "active", T)).toBeNull();
  });
});

describe("words", () => {
  it("labels and tones — finished/closed are quiet, never a live green", () => {
    expect(phaseLabel("finishing")).toBe("Finished");
    expect(phaseLabel("closed")).toBe("Closed");
    expect(phaseTone("finishing")).toBe("neutral");
    expect(phaseTone("closed")).toBe("neutral");
    expect(phaseTone("active")).toBe("success");
    expect(phaseTone("on_hold")).toBe("warning");
  });

  it("the lifecycle line says when, until when, and whether it came back", () => {
    expect(lifecycleLine({ status: "active" }, NOW)).toBeNull();
    expect(lifecycleLine({ status: "complete", completedAt: daysAgo(2) }, NOW)).toMatch(/^Finished 22 Sept · crew can log until 22 Oct$/);
    expect(lifecycleLine({ status: "complete", completedAt: daysAgo(60) }, NOW)).toMatch(/^Closed 26 July? · found by search/);
    expect(lifecycleLine({ status: "active", completedAt: daysAgo(10), reopenedAt: daysAgo(1) }, NOW)).toBe(
      "Reopened 23 Sept (finished 14 Sept)"
    );
  });

  it("the crew chip", () => {
    expect(fieldPhaseChip({ status: "active" }, NOW)).toBeNull();
    expect(fieldPhaseChip({ status: "complete", completedAt: daysAgo(1) }, NOW)).toBe("Finished · log until 23 Oct");
    expect(fieldPhaseChip({ status: "complete", completedAt: daysAgo(40) }, NOW)).toBe("Closed 15 Aug");
  });

  it("parseJobPhaseParam accepts phases only", () => {
    expect(parseJobPhaseParam("finishing")).toBe("finishing");
    expect(parseJobPhaseParam("complete")).toBeNull();
    expect(parseJobPhaseParam("")).toBeNull();
  });
});

describe("jobMatchesQuery (history search)", () => {
  const j = { name: "Smith Residence Rewire", code: "IV2055", ref: null, siteAddress: "4 Oak St, Baulkham Hills" };
  it("matches name, IV code and street, case-insensitively; never an empty query", () => {
    expect(jobMatchesQuery(j, "smith")).toBe(true);
    expect(jobMatchesQuery(j, "iv2055")).toBe(true);
    expect(jobMatchesQuery(j, "oak st")).toBe(true);
    expect(jobMatchesQuery(j, "castle")).toBe(false);
    expect(jobMatchesQuery(j, "  ")).toBe(false);
  });
});
