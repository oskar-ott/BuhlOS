import { describe, expect, it } from "vitest";
import type { Job } from "@/domains/jobs/types";
import { summariseItpReviewQueue } from "./itp-queue-card";

function job(partial: Partial<Job> & { id: string }): Job {
  return {
    name: `Job ${partial.id}`,
    ...partial,
  } as Job;
}

describe("summariseItpReviewQueue", () => {
  it("returns zero counts and falls back to /v2/jobs when no jobs", () => {
    const r = summariseItpReviewQueue([]);
    expect(r.count).toBe(0);
    expect(r.jobsAffected).toBe(0);
    expect(r.href).toBe("/v2/jobs");
  });

  it("returns zero counts when no job has a witnessed instance", () => {
    const r = summariseItpReviewQueue([
      job({ id: "j1", statsItpsActive: 3, statsItpsNeedsReview: 0 }),
      job({ id: "j2", statsItpsActive: 1, statsItpsNeedsReview: 0 }),
    ]);
    expect(r.count).toBe(0);
    expect(r.jobsAffected).toBe(0);
    expect(r.href).toBe("/v2/jobs");
  });

  it("counts witnessed instances across jobs", () => {
    const r = summariseItpReviewQueue([
      job({ id: "j1", statsItpsNeedsReview: 2 }),
      job({ id: "j2", statsItpsNeedsReview: 0 }),
      job({ id: "j3", statsItpsNeedsReview: 5 }),
    ]);
    expect(r.count).toBe(7);
    expect(r.jobsAffected).toBe(2);
    expect(r.href).toBe("/v2/jobs");
  });

  it("deep-links when exactly one job is affected", () => {
    const r = summariseItpReviewQueue([
      job({ id: "birdwood-iv3232", statsItpsNeedsReview: 3 }),
      job({ id: "other", statsItpsNeedsReview: 0 }),
    ]);
    expect(r.count).toBe(3);
    expect(r.jobsAffected).toBe(1);
    expect(r.href).toBe("/v2/jobs/birdwood-iv3232/itps");
  });

  it("encodes the jobId for the deep link", () => {
    const r = summariseItpReviewQueue([
      job({ id: "with space & slash/job", statsItpsNeedsReview: 1 }),
    ]);
    // encodeURIComponent encodes both space and slash and ampersand.
    expect(r.href).toBe("/v2/jobs/with%20space%20%26%20slash%2Fjob/itps");
  });

  it("treats missing statsItpsNeedsReview as zero (no chip ever shown)", () => {
    const r = summariseItpReviewQueue([
      job({ id: "j1" }),
      job({ id: "j2", statsItpsActive: 5 }),
    ]);
    expect(r.count).toBe(0);
    expect(r.jobsAffected).toBe(0);
    expect(r.href).toBe("/v2/jobs");
  });
});
