import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Hours sync-check engine (the migration trust layer). Compares entries AND
 * allocations across Blob and Postgres, producing PASS/FAIL + counts + totals +
 * content hashes + the specific drifts. The hash is an independent cross-check
 * of the field-level comparison.
 */

const requireFromHere = createRequire(import.meta.url);
const p = requireFromHere.resolve("../../../scripts/importers/lib/hours-sync-report.js");
const { buildHoursSyncReport } = requireFromHere(p) as {
  buildHoursSyncReport: (input: {
    blobEntries?: Array<Record<string, unknown>>;
    pgEntries?: Array<Record<string, unknown>>;
  }) => Record<string, any>;
};

function entry(over: Record<string, unknown> = {}) {
  return {
    userKey: "u1",
    date: "2026-06-01",
    totalHours: 7.6,
    ordinaryHours: 7.6,
    overtimeHours: 0,
    status: "approved",
    allocations: [{ job_id: null, hours: 7.6, notes: null, sort_order: 0 }],
    ...over,
  };
}

describe("buildHoursSyncReport", () => {
  it("PASS when Blob and Postgres are identical (entries + allocations), with matching hashes", () => {
    const r = buildHoursSyncReport({ blobEntries: [entry()], pgEntries: [entry()] });
    expect(r.status).toBe("pass");
    expect(r.matched).toBe(1);
    expect(r.details.hashMatch).toBe(true);
    expect(r.blobHash).toBe(r.pgHash);
    expect(r.allocationsChecked).toBe(true);
    expect(r.blobTotal).toBe(7.6);
  });

  it("FAIL on an allocation drift even when totals/status match (this is the whole point)", () => {
    const r = buildHoursSyncReport({
      blobEntries: [entry({ allocations: [{ job_id: "j1", hours: 7.6, notes: null, sort_order: 0 }] })],
      pgEntries: [entry({ allocations: [{ job_id: null, hours: 7.6, notes: null, sort_order: 0 }] })],
    });
    expect(r.status).toBe("fail");
    expect(r.mismatchedCount).toBe(1);
    expect(r.details.mismatched[0].diffs).toHaveProperty("allocations");
    expect(r.blobHash).not.toBe(r.pgHash);
    expect(r.details.hashMatch).toBe(false);
  });

  it("FAIL on a totals drift, with the specific diff recorded", () => {
    const r = buildHoursSyncReport({
      blobEntries: [entry({ totalHours: 7.6, ordinaryHours: 7.6 })],
      pgEntries: [entry({ totalHours: 8, ordinaryHours: 8 })],
    });
    expect(r.status).toBe("fail");
    expect(r.details.mismatched[0].diffs.totalHours).toEqual({ blob: 7.6, pg: 8 });
  });

  it("FAIL with only-in-Blob / only-in-Postgres keys recorded", () => {
    const r = buildHoursSyncReport({
      blobEntries: [entry(), entry({ date: "2026-06-02" })],
      pgEntries: [entry(), entry({ date: "2026-06-09" })],
    });
    expect(r.status).toBe("fail");
    expect(r.onlyInBlobCount).toBe(1);
    expect(r.onlyInPgCount).toBe(1);
    expect(r.details.onlyInBlob).toContain("u1|2026-06-02");
    expect(r.details.onlyInPg).toContain("u1|2026-06-09");
  });

  it("ignores numeric(4,2)-string vs number and sub-tolerance rounding in the allocation/hours compare", () => {
    const r = buildHoursSyncReport({
      blobEntries: [entry({ totalHours: 7.6, allocations: [{ job_id: null, hours: 7.6, notes: null, sort_order: 0 }] })],
      pgEntries: [entry({ totalHours: "7.60", allocations: [{ job_id: null, hours: "7.60", notes: null, sort_order: 0 }] })],
    });
    expect(r.status).toBe("pass");
    expect(r.blobHash).toBe(r.pgHash);
  });

  it("both empty = trivially in sync", () => {
    const r = buildHoursSyncReport({ blobEntries: [], pgEntries: [] });
    expect(r.status).toBe("pass");
    expect(r.blobHash).toBe(r.pgHash);
  });
});
