import { describe, expect, it } from "vitest";
import { jobOpenWork, jobOpenWorkSummary } from "./philJobsListSignals";
import type { Job } from "@/domains/jobs/types";

function job(over: Partial<Job> = {}): Job {
  return { id: "j", name: "J", status: "active", ...over } as unknown as Job;
}

describe("jobOpenWork", () => {
  it("emits the snag signal from real stats, pluralised", () => {
    expect(jobOpenWork(job({ statsSnagsV2Active: 3 }))).toEqual([
      { key: "snags", count: 3, label: "3 snags" },
    ]);
  });

  it("uses a singular label for a count of one", () => {
    expect(jobOpenWork(job({ statsSnagsV2Active: 1 }))).toEqual([
      { key: "snags", count: 1, label: "1 snag" },
    ]);
  });

  it("omits the signal when its count is zero", () => {
    expect(jobOpenWork(job({ statsSnagsV2Active: 0 }))).toEqual([]);
  });

  it("returns nothing when stats are absent — never fabricates a count", () => {
    expect(jobOpenWork(job())).toEqual([]);
  });

  it("ignores invalid counts defensively", () => {
    expect(jobOpenWork(job({ statsSnagsV2Active: 1.5 }))).toEqual([]);
    expect(jobOpenWork(job({ statsSnagsV2Active: -1 }))).toEqual([]);
    expect(
      jobOpenWork(job({ statsSnagsV2Active: Number.POSITIVE_INFINITY })),
    ).toEqual([]);
  });

  it("ignores the deleted ITP stat a stale caller might still pass", () => {
    // The ITP register left with the job-page rebuild — its old stat field
    // must never resurrect a chip.
    expect(
      jobOpenWork(job({ statsItpsActive: 4 } as unknown as Partial<Job>)),
    ).toEqual([]);
  });
});

describe("jobOpenWorkSummary", () => {
  it("joins the labels for the screen-reader summary", () => {
    expect(jobOpenWorkSummary(jobOpenWork(job({ statsSnagsV2Active: 2 })))).toBe(
      "2 snags",
    );
  });

  it("is null when there are no signals", () => {
    expect(jobOpenWorkSummary([])).toBeNull();
  });
});
