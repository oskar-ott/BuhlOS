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
      }),
    );
    expect(a.allClear).toBe(false);
    expect(a.total).toBe(3);
    expect(a.items.map((i) => [i.key, i.count])).toEqual([
      ["evidence", 2],
      ["snags", 1],
    ]);
    // Labels are office-facing and stage the destination tab via `key`.
    expect(a.items.find((i) => i.key === "snags")?.label).toBe("Open snags");
  });

  it("excludes hidden features' backlogs — no chip may link a flag-off 404 route (#915)", () => {
    const a = deriveJobAttention(
      job({
        statsEvidenceV2Pending: 2,
        statsSnagsV2Active: 5,
      }),
      { snags: false },
    );
    expect(a.items.map((i) => i.key)).toEqual(["evidence"]);
    expect(a.total).toBe(2);
  });

  it("omits zero / missing counts rather than rendering empty chips", () => {
    const a = deriveJobAttention(
      job({ statsEvidenceV2Pending: 0, statsSnagsV2Active: 4 }),
    );
    expect(a.items.map((i) => i.key)).toEqual(["snags"]);
    expect(a.total).toBe(4);
    expect(a.allClear).toBe(false);
  });

  it("is All clear when every actionable stat is zero or absent", () => {
    expect(deriveJobAttention(job()).allClear).toBe(true);
    expect(
      deriveJobAttention(job({ statsEvidenceV2Pending: 0, statsSnagsV2Active: 0 })),
    ).toEqual({ items: [], allClear: true, total: 0 });
  });

  it("never fabricates from a negative or non-finite stat", () => {
    const a = deriveJobAttention(
      job({
        statsEvidenceV2Pending: -3,
        statsSnagsV2Active: Number.NaN as unknown as number,
      }),
    );
    expect(a.allClear).toBe(true);
    expect(a.items).toHaveLength(0);
  });

  it("ignores stray legacy stats a stale caller might still pass", () => {
    // The ITP / Test & Tag registers were deleted (the job-page rebuild) —
    // their old stat fields must never resurrect an attention chip.
    const a = deriveJobAttention(
      job({ statsItpsNeedsReview: 5, statsExpiredTags: 9 } as unknown as Partial<Job>),
    );
    expect(a.allClear).toBe(true);
    expect(a.items).toHaveLength(0);
  });
});
