import { describe, expect, it } from "vitest";
import { summariseJobsRead, summarisePhilRead, type JobsReadStatus } from "./jobs-read-status";

type Diag = NonNullable<JobsReadStatus["probe"]>;

function audience(over: Partial<JobsReadStatus["counters"]["admin"]> = {}) {
  return {
    totalReads: 0, pgServedReads: 0, blobServedReads: 0, fallbackReads: 0,
    driftObservations: 0, lastDiag: null, lastAt: null,
    ...over,
  };
}

const counters: JobsReadStatus["counters"] = {
  resetAt: "2026-06-21T00:00:00.000Z",
  admin: audience({ totalReads: 3, pgServedReads: 2, blobServedReads: 1, fallbackReads: 1, lastAt: "2026-06-21T00:00:00.000Z" }),
  phil: audience(),
};

function status(over: Partial<JobsReadStatus>): JobsReadStatus {
  return { wired: true, flagOn: true, philFlagOn: false, probe: null, counters, ...over };
}

function diag(over: Partial<Diag> = {}): Diag {
  return {
    readSource: "postgres", reason: "served from postgres", flagOn: true,
    reconstructed: true, parityMatch: true, pgFaithfulCount: 5, driftedCount: 0,
    onlyInBlobCount: 1, onlyInPgCount: 0, matchedCount: 5,
    blobHash: "abc", pgHash: "abc", latencyMs: 12, fallbackUsed: false, error: null,
    ...over,
  };
}

describe("summariseJobsRead (admin)", () => {
  it("not wired → not_wired, no metrics", () => {
    const s = summariseJobsRead(status({ wired: false, flagOn: false }));
    expect(s.state).toBe("not_wired");
    expect(s.readSource).toBe("blob");
    expect(s.totalReads).toBe(3); // from counters.admin
  });

  it("wired but probe errored → error, surfaces the message", () => {
    const s = summariseJobsRead(status({ probe: null, error: "pooler down" }));
    expect(s.state).toBe("error");
    expect(s.error).toBe("pooler down");
  });

  it("flag off (probe reconstructed) → flag_off with parity reported", () => {
    const s = summariseJobsRead(status({ flagOn: false, probe: diag({ flagOn: false }) }));
    expect(s.state).toBe("flag_off");
    expect(s.pgFaithfulCount).toBe(5);
    expect(s.hashMatch).toBe(true);
  });

  it("flag on but reconstruction failed → fallback", () => {
    const s = summariseJobsRead(status({
      probe: diag({ reconstructed: false, readSource: "blob", parityMatch: null, matchedCount: 0, blobHash: null, pgHash: null, error: "no tenant" }),
    }));
    expect(s.state).toBe("fallback");
    expect(s.error).toBe("no tenant");
    expect(s.hashMatch).toBeNull();
  });

  it("flag on + reconstructed → active", () => {
    const s = summariseJobsRead(status({ probe: diag() }));
    expect(s.state).toBe("active");
    expect(s.readSource).toBe("postgres");
    expect(s.parityMatch).toBe(true);
    expect(s.fallbackReads).toBe(1); // admin bucket
  });

  it("active with drift → hashMatch false", () => {
    const s = summariseJobsRead(status({
      probe: diag({ parityMatch: false, driftedCount: 2, pgFaithfulCount: 3, blobHash: "x", pgHash: "y" }),
    }));
    expect(s.state).toBe("active");
    expect(s.hashMatch).toBe(false);
    expect(s.driftedCount).toBe(2);
  });
});

describe("summarisePhilRead (field)", () => {
  it("reports the Phil flag + phil-bucket counters (no live probe)", () => {
    const philCounters: JobsReadStatus["counters"] = {
      resetAt: "2026-06-21T00:00:00.000Z",
      admin: audience(),
      phil: audience({
        totalReads: 4, pgServedReads: 3, blobServedReads: 1, fallbackReads: 1,
        lastAt: "2026-06-21T01:00:00.000Z",
        lastDiag: { pgFaithfulCount: 2, matchedCount: 3 },
      }),
    };
    const p = summarisePhilRead(status({ philFlagOn: true, counters: philCounters }));
    expect(p.flagOn).toBe(true);
    expect(p.totalReads).toBe(4);
    expect(p.pgServedReads).toBe(3);
    expect(p.blobServedReads).toBe(1);
    expect(p.fallbackReads).toBe(1);
    expect(p.lastPgFaithful).toBe(2);
    expect(p.lastMatched).toBe(3);
  });

  it("honest nulls when no field read has happened yet", () => {
    const p = summarisePhilRead(status({ philFlagOn: false }));
    expect(p.flagOn).toBe(false);
    expect(p.totalReads).toBe(0);
    expect(p.lastPgFaithful).toBeNull();
    expect(p.lastMatched).toBeNull();
    expect(p.lastAt).toBeNull();
  });
});
