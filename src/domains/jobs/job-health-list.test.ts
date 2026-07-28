import { describe, expect, it } from "vitest";
import { deriveJobHealth } from "./job-health";
import {
  healthCounts,
  healthLabel,
  healthRank,
  parseHealthParam,
  sortByHealth,
  type JobWithHealth,
} from "./job-health-list";

/**
 * #227 — list-level health helpers: rank, parse, stable sort, counts. The
 * underlying derivation is tested in job-health.test.ts; these pin the
 * "needs me first" triage the jobs list adds.
 */

function withHealth(id: string, stats: Record<string, number>): JobWithHealth<{ id: string }> {
  return { job: { id }, health: deriveJobHealth(stats as never) };
}

describe("rank + parse", () => {
  it("ranks trouble first, honest-unknown last", () => {
    expect(healthRank("at-risk")).toBeLessThan(healthRank("watch"));
    expect(healthRank("watch")).toBeLessThan(healthRank("good"));
    expect(healthRank("good")).toBeLessThan(healthRank("unknown"));
  });
  it("validates the health URL param", () => {
    expect(parseHealthParam("at-risk")).toBe("at-risk");
    expect(parseHealthParam("good")).toBe("good");
    expect(parseHealthParam("nonsense")).toBeNull();
    expect(parseHealthParam(null)).toBeNull();
  });
  it("labels each level for the badge/pill", () => {
    expect(healthLabel("at-risk")).toBe("At risk");
    expect(healthLabel("unknown")).toBe("No data");
  });
});

describe("sortByHealth — stable, trouble first", () => {
  it("orders at-risk → watch → good → unknown, preserving input order within a level", () => {
    const items = [
      withHealth("good1", { statsEvidenceV2Pending: 0 }), // good
      withHealth("risk1", { statsExpiredTags: 2 }), // at-risk (hard)
      withHealth("watch1", { statsEvidenceV2Pending: 1 }), // watch
      withHealth("unknown1", {}), // no signals → unknown
      withHealth("good2", { statsEvidenceV2Pending: 0 }), // good
    ];
    expect(sortByHealth(items).map((x) => x.job.id)).toEqual([
      "risk1",
      "watch1",
      "good1",
      "good2", // stable: good1 before good2
      "unknown1",
    ]);
  });
});

describe("healthCounts — for the filter pills", () => {
  it("tallies each level", () => {
    const items = [
      withHealth("a", { statsExpiredTags: 1 }),
      withHealth("b", { statsEvidenceV2Pending: 1 }),
      withHealth("c", { statsEvidenceV2Pending: 0 }),
      withHealth("d", {}),
    ];
    expect(healthCounts(items)).toEqual({ "at-risk": 1, watch: 1, good: 1, unknown: 1 });
  });
});
