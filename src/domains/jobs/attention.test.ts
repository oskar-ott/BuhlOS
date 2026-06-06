import { describe, expect, it } from "vitest";
import { deriveJobAttention } from "./attention";
import type { Job } from "./types";

function job(over: Partial<Job> = {}): Job {
  return { id: "job-1", name: "Birdwood IV3232", ...over } as unknown as Job;
}

describe("deriveJobAttention", () => {
  it("surfaces only the real, positive actionable counts (deep-linkable tabs)", () => {
    const a = deriveJobAttention(
      job({
        statsEvidenceV2Pending: 2,
        statsSnagsV2Active: 1,
        statsItpsNeedsReview: 3,
      }),
    );
    expect(a.allClear).toBe(false);
    expect(a.total).toBe(6);
    expect(a.items.map((i) => [i.key, i.count])).toEqual([
      ["evidence", 2],
      ["snags", 1],
      ["itps", 3],
    ]);
    // Labels are office-facing and stage the destination tab via `key`.
    expect(a.items.find((i) => i.key === "snags")?.label).toBe("Open snags");
  });

  it("omits zero / missing counts rather than rendering empty chips", () => {
    const a = deriveJobAttention(
      job({ statsEvidenceV2Pending: 0, statsSnagsV2Active: 4 /* itps missing */ }),
    );
    expect(a.items.map((i) => i.key)).toEqual(["snags"]);
    expect(a.total).toBe(4);
    expect(a.allClear).toBe(false);
  });

  it("is All clear when every actionable stat is zero or absent", () => {
    expect(deriveJobAttention(job()).allClear).toBe(true);
    expect(
      deriveJobAttention(
        job({ statsEvidenceV2Pending: 0, statsSnagsV2Active: 0, statsItpsNeedsReview: 0 }),
      ),
    ).toEqual({ items: [], allClear: true, total: 0 });
  });

  it("never fabricates from a negative or non-finite stat", () => {
    const a = deriveJobAttention(
      job({
        statsEvidenceV2Pending: -3,
        statsSnagsV2Active: Number.NaN as unknown as number,
        statsItpsNeedsReview: 5,
      }),
    );
    expect(a.items.map((i) => i.key)).toEqual(["itps"]);
    expect(a.total).toBe(5);
  });

  it("does not surface gear-tag expiry (no per-job destination)", () => {
    const a = deriveJobAttention(
      job({ statsExpiredTags: 9, statsExpiringTags: 4 } as Partial<Job>),
    );
    expect(a.allClear).toBe(true);
    expect(a.items).toHaveLength(0);
  });
});
