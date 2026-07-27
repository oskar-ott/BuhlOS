import { describe, it, expect } from "vitest";
import {
  buildJobSummaries,
  getExceptionCounts,
  groupExceptionsByJob,
  groupExceptionsBySource,
} from "./grouping";
import type { ExceptionItem } from "./types";

function ex(over: Partial<ExceptionItem> & { id: string }): ExceptionItem {
  return {
    source: "job",
    sourceId: over.id,
    title: over.id,
    severity: "warning",
    actionState: "available",
    actionHref: "/v2/jobs/x/builder",
    ...over,
  } as ExceptionItem;
}

const ITEMS: ExceptionItem[] = [
  ex({ id: "a", jobId: "j1", jobName: "Alpha", source: "evidence", severity: "warning", actionHref: "/v2/jobs/j1/evidence" }),
  ex({ id: "b", jobId: "j1", jobName: "Alpha", source: "job", severity: "critical", actionHref: "/v2/jobs/j1/builder" }),
  ex({ id: "c", jobId: "j2", jobName: "Bravo", source: "evidence", severity: "info", actionHref: "/v2/jobs/j2/evidence" }),
  ex({ id: "d", source: "hours", severity: "warning", jobId: undefined, actionHref: "/hours/approvals" }), // no job → General
  ex({ id: "e", source: "gear", severity: "info", jobId: undefined, actionState: "unavailable", actionHref: undefined }), // waiting
];

describe("groupExceptionsByJob", () => {
  const groups = groupExceptionsByJob(ITEMS);

  it("groups under job, puts no-job items under General (last)", () => {
    expect(groups.map((g) => g.jobName)).toEqual(["Alpha", "Bravo", "General"]);
    expect(groups[groups.length - 1]!.jobId).toBeNull();
  });

  it("orders job groups by highest severity, then name", () => {
    // Alpha has a critical → before Bravo (info only)
    expect(groups[0]!.jobName).toBe("Alpha");
    expect(groups[0]!.highestSeverity).toBe("critical");
    expect(groups[1]!.highestSeverity).toBe("info");
  });

  it("preserves input order of items within a group + correct counts", () => {
    const alpha = groups.find((g) => g.jobName === "Alpha")!;
    expect(alpha.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(alpha.count).toBe(2);
  });
});

describe("groupExceptionsBySource", () => {
  it("groups by source, ordered by count desc then label", () => {
    const groups = groupExceptionsBySource([
      ex({ id: "1", source: "hours" }),
      ex({ id: "2", source: "hours" }),
      ex({ id: "3", source: "job" }),
    ]);
    expect(groups.map((g) => g.source)).toEqual(["hours", "job"]);
    expect(groups[0]).toMatchObject({ sourceLabel: "Hours", count: 2 });
  });
});

describe("getExceptionCounts", () => {
  it("rolls up totals, severity, jobs affected, actionable + waiting", () => {
    const c = getExceptionCounts(ITEMS);
    expect(c.total).toBe(5);
    expect(c.bySeverity.critical).toBe(1);
    expect(c.jobsAffected).toBe(2); // j1, j2 (General item has no jobId)
    expect(c.actionable).toBe(4); // all but the unavailable gear item
    expect(c.waiting).toBe(1);
  });
});

describe("buildJobSummaries", () => {
  it("returns per-job rollups (excluding the no-job General bucket)", () => {
    const sums = buildJobSummaries(ITEMS);
    expect(sums.map((s) => s.jobId)).toEqual(["j1", "j2"]);
    expect(sums.find((s) => s.jobId === "j1")).toMatchObject({ total: 2, critical: 1, actionable: 2 });
  });
});
