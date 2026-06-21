import { describe, expect, it } from "vitest";
import { summariseJobsRead, type JobsReadStatus } from "./jobs-read-status";

type Diag = NonNullable<JobsReadStatus["probe"]>;

const counters = {
  resetAt: "2026-06-21T00:00:00.000Z",
  totalReads: 3, pgServedReads: 2, blobServedReads: 1, fallbackReads: 1,
  driftObservations: 0, lastDiag: null, lastAt: "2026-06-21T00:00:00.000Z",
};

function diag(over: Partial<Diag> = {}): Diag {
  return {
    readSource: "postgres", reason: "served from postgres", flagOn: true,
    reconstructed: true, parityMatch: true, pgFaithfulCount: 5, driftedCount: 0,
    onlyInBlobCount: 1, onlyInPgCount: 0, matchedCount: 5,
    blobHash: "abc", pgHash: "abc", latencyMs: 12, fallbackUsed: false, error: null,
    ...over,
  };
}

describe("summariseJobsRead", () => {
  it("not wired → not_wired, no metrics", () => {
    const s = summariseJobsRead({ wired: false, flagOn: false, probe: null, counters });
    expect(s.state).toBe("not_wired");
    expect(s.readSource).toBe("blob");
    expect(s.totalReads).toBe(3);
  });

  it("wired but probe errored → error, surfaces the message", () => {
    const s = summariseJobsRead({ wired: true, flagOn: true, probe: null, counters, error: "pooler down" });
    expect(s.state).toBe("error");
    expect(s.error).toBe("pooler down");
  });

  it("flag off (probe reconstructed) → flag_off with parity reported", () => {
    const s = summariseJobsRead({ wired: true, flagOn: false, probe: diag({ flagOn: false }), counters });
    expect(s.state).toBe("flag_off");
    expect(s.pgFaithfulCount).toBe(5);
    expect(s.hashMatch).toBe(true);
  });

  it("flag on but reconstruction failed → fallback", () => {
    const s = summariseJobsRead({
      wired: true, flagOn: true, counters,
      probe: diag({ reconstructed: false, readSource: "blob", parityMatch: null, matchedCount: 0, blobHash: null, pgHash: null, error: "no tenant" }),
    });
    expect(s.state).toBe("fallback");
    expect(s.error).toBe("no tenant");
    expect(s.hashMatch).toBeNull();
  });

  it("flag on + reconstructed → active", () => {
    const s = summariseJobsRead({ wired: true, flagOn: true, probe: diag(), counters });
    expect(s.state).toBe("active");
    expect(s.readSource).toBe("postgres");
    expect(s.parityMatch).toBe(true);
    expect(s.fallbackReads).toBe(1);
  });

  it("active with drift → hashMatch false", () => {
    const s = summariseJobsRead({
      wired: true, flagOn: true, counters,
      probe: diag({ parityMatch: false, driftedCount: 2, pgFaithfulCount: 3, blobHash: "x", pgHash: "y" }),
    });
    expect(s.state).toBe("active");
    expect(s.hashMatch).toBe(false);
    expect(s.driftedCount).toBe(2);
  });
});
