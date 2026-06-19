import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Hours sync-check engine (the migration trust layer). Compares entries AND
 * allocations across Blob and Postgres, producing PASS/FAIL + counts + totals +
 * content hashes + the specific drifts. The hash is an independent cross-check
 * of the field-level comparison.
 */

type SyncReport = {
  status: string;
  blobCount: number;
  pgCount: number;
  blobTotal: number;
  pgTotal: number;
  allocationsChecked: boolean;
  matched: number;
  onlyInBlobCount: number;
  onlyInPgCount: number;
  mismatchedCount: number;
  blobHash: string;
  pgHash: string;
  details: {
    hashMatch: boolean;
    onlyInBlob: string[];
    onlyInPg: string[];
    mismatched: Array<{ key: string; diffs: Record<string, unknown> }>;
  };
};

const requireFromHere = createRequire(import.meta.url);
const p = requireFromHere.resolve("../../../scripts/importers/lib/hours-sync-report.js");
const { buildHoursSyncReport, normaliseEntry } = requireFromHere(p) as {
  buildHoursSyncReport: (input: {
    blobEntries?: Array<Record<string, unknown>>;
    pgEntries?: Array<Record<string, unknown>>;
  }) => SyncReport;
  normaliseEntry: (
    userKey: string,
    date: string,
    e: Record<string, unknown>
  ) => { allocations: Array<{ job_id: string | null; hours: unknown; notes: string | null; sort_order: number }> };
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
    expect(r.details.mismatched[0]!.diffs).toHaveProperty("allocations");
    expect(r.blobHash).not.toBe(r.pgHash);
    expect(r.details.hashMatch).toBe(false);
  });

  it("FAIL on a totals drift, with the specific diff recorded", () => {
    const r = buildHoursSyncReport({
      blobEntries: [entry({ totalHours: 7.6, ordinaryHours: 7.6 })],
      pgEntries: [entry({ totalHours: 8, ordinaryHours: 8 })],
    });
    expect(r.status).toBe("fail");
    expect(r.details.mismatched[0]!.diffs.totalHours).toEqual({ blob: 7.6, pg: 8 });
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

describe("normaliseEntry — matches how alloc-pg wrote PG (no false drift on legacy data)", () => {
  it("falls back sort_order to the array index when the blob allocation has none", () => {
    const n = normaliseEntry("u1", "2026-06-01", {
      totalHours: 8, ordinaryHours: 8, overtimeHours: 0, status: "draft",
      allocations: [{ jobId: null, hours: 8 }], // no sortOrder
    });
    expect(n.allocations[0]!.sort_order).toBe(0);
  });

  it("collapses whitespace-only allocation notes to null (strOrNull), matching PG storage", () => {
    const n = normaliseEntry("u1", "2026-06-01", {
      totalHours: 8, ordinaryHours: 8, overtimeHours: 0, status: "draft",
      allocations: [{ jobId: null, hours: 8, notes: "   ", sortOrder: 0 }],
    });
    expect(n.allocations[0]!.notes).toBeNull();
  });

  it("a blob entry lacking sortOrder/whitespace-notes is IN SYNC with its PG-stored form", () => {
    const blob = normaliseEntry("u1", "2026-06-01", {
      totalHours: 8, ordinaryHours: 8, overtimeHours: 0, status: "draft",
      allocations: [{ jobId: null, hours: 8, notes: "  " }], // no sortOrder, whitespace notes
    });
    const pg = normaliseEntry("u1", "2026-06-01", {
      totalHours: 8, ordinaryHours: 8, overtimeHours: 0, status: "draft",
      allocations: [{ jobId: null, hours: "8.00", notes: null, sortOrder: 0 }], // as alloc-pg stored it
    });
    const r = buildHoursSyncReport({ blobEntries: [blob], pgEntries: [pg] });
    expect(r.status).toBe("pass");
    expect(r.blobHash).toBe(r.pgHash);
  });
});
