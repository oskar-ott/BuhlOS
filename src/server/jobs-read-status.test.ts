import { describe, expect, it } from "vitest";
import { summariseJobsRead, summarisePhilRead, summariseTaskRead, summariseAdminTaskRead, summariseTaskReadProbe, summariseEvidenceReadProbe, summariseAdminEvidenceRead, summarisePhilEvidenceRead, loadSourceMode, type JobsReadStatus, type TaskReadStatus, type AdminTaskReadStatus, type TaskReadProbeStatus, type EvidenceReadProbeStatus, type AdminEvidenceReadStatus, type PhilEvidenceReadStatus } from "./jobs-read-status";

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

describe("summariseTaskRead (J10 — Phil task-status read)", () => {
  const counters = (over: Partial<TaskReadStatus["counters"]> = {}): TaskReadStatus["counters"] => ({
    resetAt: "2026-06-21T00:00:00.000Z",
    totalReads: 0, pgServedReads: 0, blobServedReads: 0, fallbackReads: 0, parityMismatches: 0,
    lastDiag: null, lastAt: null, ...over,
  });

  it("reports flag + counters + last source/parity", () => {
    const s = summariseTaskRead({
      flagOn: true,
      counters: counters({
        totalReads: 5, pgServedReads: 3, blobServedReads: 2, fallbackReads: 1, parityMismatches: 1,
        lastAt: "2026-06-21T01:00:00.000Z",
        lastDiag: { source: "postgres", reason: "served from postgres", flagOn: true, parityPass: true, matched: 10, mismatched: 0, orphans: 0, unresolved: 0, hashMatch: true, latencyMs: 12, fallbackUsed: false },
      }),
    });
    expect(s.flagOn).toBe(true);
    expect(s.totalReads).toBe(5);
    expect(s.pgServedReads).toBe(3);
    expect(s.parityMismatches).toBe(1);
    expect(s.lastSource).toBe("postgres");
    expect(s.lastParityPass).toBe(true);
  });

  it("honest nulls before any read", () => {
    const s = summariseTaskRead({ flagOn: false, counters: counters() });
    expect(s.flagOn).toBe(false);
    expect(s.totalReads).toBe(0);
    expect(s.lastSource).toBeNull();
    expect(s.lastParityPass).toBeNull();
  });
});

describe("summariseAdminTaskRead (J11 — admin task-status read)", () => {
  const counters = (over: Partial<AdminTaskReadStatus["counters"]> = {}): AdminTaskReadStatus["counters"] => ({
    resetAt: "2026-06-21T00:00:00.000Z",
    totalReads: 0, pgServedReads: 0, blobServedReads: 0, fallbackReads: 0, parityMismatches: 0,
    lastDiag: null, lastAt: null, ...over,
  });

  it("reports flag + counters + last source/parity (same shape as J10)", () => {
    const s = summariseAdminTaskRead({
      flagOn: true,
      counters: counters({
        totalReads: 7, pgServedReads: 6, blobServedReads: 1, fallbackReads: 0, parityMismatches: 0,
        lastAt: "2026-06-21T02:00:00.000Z",
        lastDiag: { source: "postgres", reason: "served from postgres", flagOn: true, parityPass: true, matched: 20, mismatched: 0, orphans: 0, unresolved: 0, hashMatch: true, latencyMs: 9, fallbackUsed: false },
      }),
    });
    expect(s.flagOn).toBe(true);
    expect(s.totalReads).toBe(7);
    expect(s.pgServedReads).toBe(6);
    expect(s.lastSource).toBe("postgres");
    expect(s.lastParityPass).toBe(true);
  });

  it("honest nulls before any read", () => {
    const s = summariseAdminTaskRead({ flagOn: false, counters: counters() });
    expect(s.flagOn).toBe(false);
    expect(s.totalReads).toBe(0);
    expect(s.lastSource).toBeNull();
    expect(s.lastParityPass).toBeNull();
  });
});

describe("summariseTaskReadProbe (J12 — live readiness probe)", () => {
  const probe = (over: Partial<NonNullable<TaskReadProbeStatus["probe"]>> = {}): NonNullable<TaskReadProbeStatus["probe"]> => ({
    wired: true, jobsTotal: 0, jobsSampled: 0, pgFaithful: 0, drifted: 0, errored: 0, unavailable: 0,
    totalMismatched: 0, totalUnresolved: 0, totalOrphans: 0, hashDriftJobs: 0, latencyMs: 5, error: null, ...over,
  });

  it("not wired → not_wired, not ready", () => {
    const s = summariseTaskReadProbe({ wired: false, probe: null });
    expect(s.state).toBe("not_wired");
    expect(s.readyForPromotion).toBe(false);
  });

  it("probe errored → error, surfaces the message, not ready", () => {
    const s = summariseTaskReadProbe({ wired: true, probe: null, error: "pooler down" });
    expect(s.state).toBe("error");
    expect(s.error).toBe("pooler down");
    expect(s.readyForPromotion).toBe(false);
  });

  it("every sampled job faithful → all_faithful + readyForPromotion", () => {
    const s = summariseTaskReadProbe({ wired: true, probe: probe({ jobsTotal: 9, jobsSampled: 9, pgFaithful: 9 }) });
    expect(s.state).toBe("all_faithful");
    expect(s.readyForPromotion).toBe(true);
    expect(s.pgFaithful).toBe(9);
  });

  it("any drift → drift state, NOT ready", () => {
    const s = summariseTaskReadProbe({ wired: true, probe: probe({ jobsTotal: 9, jobsSampled: 9, pgFaithful: 8, drifted: 1, totalMismatched: 2, hashDriftJobs: 1 }) });
    expect(s.state).toBe("drift");
    expect(s.readyForPromotion).toBe(false);
    expect(s.drifted).toBe(1);
    expect(s.totalMismatched).toBe(2);
  });

  it("errored/unavailable jobs also block readiness", () => {
    const s = summariseTaskReadProbe({ wired: true, probe: probe({ jobsTotal: 5, jobsSampled: 5, pgFaithful: 4, unavailable: 1 }) });
    expect(s.readyForPromotion).toBe(false);
  });

  it("no jobs sampled → empty, not ready", () => {
    const s = summariseTaskReadProbe({ wired: true, probe: probe({ jobsTotal: 0, jobsSampled: 0 }) });
    expect(s.state).toBe("empty");
    expect(s.readyForPromotion).toBe(false);
  });
});

describe("summariseEvidenceReadProbe (evidence metadata readiness)", () => {
  const probe = (over: Partial<NonNullable<EvidenceReadProbeStatus["probe"]>> = {}): NonNullable<EvidenceReadProbeStatus["probe"]> => ({
    available: true, jobsTotal: 0, jobsSampled: 0, faithful: 0, drifted: 0, unavailable: 0,
    matchedEvidence: 0, mismatchedEvidence: 0, missingInPg: 0, missingInBlob: 0,
    readyForOverlay: false, latencyMs: 5, fallbackReason: null, ...over,
  });

  it("not wired → not_wired, not ready", () => {
    const s = summariseEvidenceReadProbe({ wired: false, probe: null });
    expect(s.state).toBe("not_wired");
    expect(s.readyForOverlay).toBe(false);
  });

  it("loader-reported error → error, not ready", () => {
    const s = summariseEvidenceReadProbe({ wired: true, probe: null, error: "pooler down" });
    expect(s.state).toBe("error");
    expect(s.error).toBe("pooler down");
  });

  it("probe-captured error fallback → error state", () => {
    const s = summariseEvidenceReadProbe({ wired: true, probe: probe({ available: true, fallbackReason: "error", error: "boom" }) });
    expect(s.state).toBe("error");
    expect(s.error).toBe("boom");
  });

  it("every sampled job evidence-faithful → all_faithful + readyForOverlay", () => {
    const s = summariseEvidenceReadProbe({ wired: true, probe: probe({ jobsTotal: 9, jobsSampled: 9, faithful: 9, matchedEvidence: 4, readyForOverlay: true }) });
    expect(s.state).toBe("all_faithful");
    expect(s.readyForOverlay).toBe(true);
    expect(s.matchedEvidence).toBe(4);
  });

  it("any drift → drift state, NOT ready, surfaces breakdown", () => {
    const s = summariseEvidenceReadProbe({ wired: true, probe: probe({ jobsTotal: 9, jobsSampled: 9, faithful: 8, drifted: 1, mismatchedEvidence: 1, missingInPg: 1 }) });
    expect(s.state).toBe("drift");
    expect(s.readyForOverlay).toBe(false);
    expect(s.drifted).toBe(1);
    expect(s.mismatchedEvidence).toBe(1);
    expect(s.missingInPg).toBe(1);
  });

  it("no jobs sampled → empty, not ready", () => {
    const s = summariseEvidenceReadProbe({ wired: true, probe: probe({ jobsTotal: 0, jobsSampled: 0 }) });
    expect(s.state).toBe("empty");
    expect(s.readyForOverlay).toBe(false);
  });
});

describe("summariseAdminEvidenceRead (admin evidence overlay counters)", () => {
  const counters = (over: Partial<AdminEvidenceReadStatus["counters"]> = {}): AdminEvidenceReadStatus["counters"] => ({
    resetAt: "2026-06-22T00:00:00.000Z",
    totalReads: 0, pgServedReads: 0, blobServedReads: 0, fallbackReads: 0, parityMismatches: 0,
    lastDiag: null, lastAt: null, ...over,
  });

  it("reports flag + counters + last source/parity", () => {
    const s = summariseAdminEvidenceRead({
      flagOn: true,
      counters: counters({
        totalReads: 5, pgServedReads: 3, blobServedReads: 2, fallbackReads: 1, parityMismatches: 1,
        lastAt: "2026-06-22T01:00:00.000Z",
        lastDiag: { source: "postgres", reason: "served from postgres", flagOn: true, parityPass: true, matched: 4, mismatched: 0, missingInPg: 0, missingInBlob: 0, latencyMs: 9, fallbackUsed: false },
      }),
    });
    expect(s.flagOn).toBe(true);
    expect(s.totalReads).toBe(5);
    expect(s.pgServedReads).toBe(3);
    expect(s.parityMismatches).toBe(1);
    expect(s.lastSource).toBe("postgres");
    expect(s.lastParityPass).toBe(true);
  });

  it("honest nulls before any read", () => {
    const s = summariseAdminEvidenceRead({ flagOn: false, counters: counters() });
    expect(s.flagOn).toBe(false);
    expect(s.totalReads).toBe(0);
    expect(s.lastSource).toBeNull();
    expect(s.lastParityPass).toBeNull();
  });
});

describe("summarisePhilEvidenceRead (field evidence overlay counters)", () => {
  const counters = (over: Partial<PhilEvidenceReadStatus["counters"]> = {}): PhilEvidenceReadStatus["counters"] => ({
    resetAt: "2026-06-22T00:00:00.000Z",
    totalReads: 0, pgServedReads: 0, blobServedReads: 0, fallbackReads: 0, parityMismatches: 0,
    lastDiag: null, lastAt: null, ...over,
  });

  it("reports flag + counters + last source/parity", () => {
    const s = summarisePhilEvidenceRead({
      flagOn: true,
      counters: counters({
        totalReads: 7, pgServedReads: 6, blobServedReads: 1, fallbackReads: 1, parityMismatches: 0,
        lastAt: "2026-06-22T02:00:00.000Z",
        lastDiag: { source: "postgres", reason: "served from postgres", flagOn: true, parityPass: true, matched: 3, mismatched: 0, missingInPg: 0, missingInBlob: 0, latencyMs: 7, fallbackUsed: false },
      }),
    });
    expect(s.flagOn).toBe(true);
    expect(s.totalReads).toBe(7);
    expect(s.pgServedReads).toBe(6);
    expect(s.lastSource).toBe("postgres");
    expect(s.lastParityPass).toBe(true);
  });

  it("honest nulls before any read", () => {
    const s = summarisePhilEvidenceRead({ flagOn: false, counters: counters() });
    expect(s.flagOn).toBe(false);
    expect(s.totalReads).toBe(0);
    expect(s.lastSource).toBeNull();
    expect(s.lastParityPass).toBeNull();
  });
});

describe("loadSourceMode (write source-mode readout)", () => {
  it("lists each promotable domain with its source flag; default OFF → Blob", async () => {
    const m = await loadSourceMode(); // no env/flags in test → all default false
    const task = m.rows.find((r) => r.flag === "supabase_source_tasks");
    expect(task).toBeTruthy();
    expect(task?.domain).toBe("Task status");
    expect(task?.pgSource).toBe(false);
    expect(m.anyPgSource).toBe(false);
  });
});
