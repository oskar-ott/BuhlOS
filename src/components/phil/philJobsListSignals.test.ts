import { describe, expect, it } from "vitest";
import { jobOpenWork, jobOpenWorkSummary } from "./philJobsListSignals";
import type { Job } from "@/domains/jobs/types";

function job(over: Partial<Job> = {}): Job {
  return { id: "j", name: "J", status: "active", ...over } as unknown as Job;
}

describe("jobOpenWork", () => {
  it("emits snag + ITP signals from real stats, pluralised", () => {
    expect(
      jobOpenWork(job({ statsSnagsV2Active: 3, statsItpsActive: 2 })),
    ).toEqual([
      { key: "snags", count: 3, label: "3 snags" },
      { key: "itps", count: 2, label: "2 ITPs" },
    ]);
  });

  it("uses singular labels for a count of one", () => {
    expect(
      jobOpenWork(job({ statsSnagsV2Active: 1, statsItpsActive: 1 })),
    ).toEqual([
      { key: "snags", count: 1, label: "1 snag" },
      { key: "itps", count: 1, label: "1 ITP" },
    ]);
  });

  it("omits a signal whose count is zero", () => {
    expect(
      jobOpenWork(job({ statsSnagsV2Active: 0, statsItpsActive: 4 })),
    ).toEqual([{ key: "itps", count: 4, label: "4 ITPs" }]);
  });

  it("returns nothing when stats are absent — never fabricates a count", () => {
    expect(jobOpenWork(job())).toEqual([]);
  });
});

describe("jobOpenWorkSummary", () => {
  it("joins the labels for the screen-reader summary", () => {
    expect(
      jobOpenWorkSummary(
        jobOpenWork(job({ statsSnagsV2Active: 2, statsItpsActive: 1 })),
      ),
    ).toBe("2 snags, 1 ITP");
  });

  it("is null when there are no signals", () => {
    expect(jobOpenWorkSummary([])).toBeNull();
  });
});
