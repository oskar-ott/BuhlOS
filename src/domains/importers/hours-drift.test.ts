import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Hours Blob↔Postgres drift engine — the read-only hours proving slice's core
 * and the future dual-write drift alarm (#152, roadmap P7). Pure function;
 * these cover the four drift classes (missing-in-PG, orphan-in-PG, value
 * mismatch, duplicate keys), the numeric tolerance, the empty-PG "behind by
 * everything" case, and the drift-hours sign convention.
 */

const requireFromHere = createRequire(import.meta.url);
const driftPath = requireFromHere.resolve("../../../scripts/importers/lib/hours-drift.js");
const { buildHoursDriftReport, HOURS_TOLERANCE } = requireFromHere(driftPath) as {
  buildHoursDriftReport: (input: {
    blobEntries?: Array<Record<string, unknown>>;
    pgEntries?: Array<Record<string, unknown>>;
  }) => {
    onlyInBlob: Array<Record<string, unknown>>;
    onlyInPg: Array<Record<string, unknown>>;
    mismatched: Array<{ key: string; diffs: Record<string, unknown> }>;
    duplicateBlobKeys: Array<Record<string, unknown>>;
    duplicatePgKeys: Array<Record<string, unknown>>;
    unresolvedBlob: Array<Record<string, unknown>>;
    unresolvedPg: Array<Record<string, unknown>>;
    summary: Record<string, number | boolean>;
  };
  HOURS_TOLERANCE: number;
};

function entry(over: Record<string, unknown> = {}) {
  return {
    userKey: "u1",
    date: "2026-06-01",
    totalHours: 8,
    ordinaryHours: 8,
    overtimeHours: 0,
    status: "approved",
    ...over,
  };
}

describe("buildHoursDriftReport", () => {
  it("treats an empty Postgres as 'behind by everything' (the proving-slice default)", () => {
    const blobEntries = [entry(), entry({ date: "2026-06-02", totalHours: 6, ordinaryHours: 6 })];
    const r = buildHoursDriftReport({ blobEntries, pgEntries: [] });
    expect(r.summary.onlyInBlobCount).toBe(2);
    expect(r.summary.pgCount).toBe(0);
    expect(r.summary.inSync).toBe(false);
    expect(r.summary.blobTotalHours).toBe(14);
    expect(r.summary.driftHours).toBe(14); // positive = Postgres behind
  });

  it("reports IN SYNC when both sides agree", () => {
    const blobEntries = [entry(), entry({ date: "2026-06-02" })];
    const pgEntries = [entry(), entry({ date: "2026-06-02" })];
    const r = buildHoursDriftReport({ blobEntries, pgEntries });
    expect(r.summary.inSync).toBe(true);
    expect(r.summary.matchedCount).toBe(2);
    expect(r.summary.driftHours).toBe(0);
    expect(r.onlyInBlob).toHaveLength(0);
    expect(r.onlyInPg).toHaveLength(0);
    expect(r.mismatched).toHaveLength(0);
  });

  it("flags an orphan row present only in Postgres", () => {
    const r = buildHoursDriftReport({
      blobEntries: [entry()],
      pgEntries: [entry(), entry({ date: "2026-06-09" })],
    });
    expect(r.summary.onlyInPgCount).toBe(1);
    expect(r.onlyInPg[0]!.date).toBe("2026-06-09");
    expect(r.summary.driftHours).toBe(-8); // negative = Postgres ahead
    expect(r.summary.inSync).toBe(false);
  });

  it("flags value mismatches on the same key (hours and status)", () => {
    const r = buildHoursDriftReport({
      blobEntries: [entry({ totalHours: 8, ordinaryHours: 8, status: "approved" })],
      pgEntries: [entry({ totalHours: 7, ordinaryHours: 7, status: "submitted" })],
    });
    expect(r.summary.mismatchedCount).toBe(1);
    expect(r.mismatched[0]!.diffs).toMatchObject({
      totalHours: { blob: 8, pg: 7 },
      ordinaryHours: { blob: 8, pg: 7 },
      status: { blob: "approved", pg: "submitted" },
    });
    expect(r.summary.matchedCount).toBe(0);
  });

  it("ignores hour differences within the schema tolerance", () => {
    const delta = HOURS_TOLERANCE / 2;
    const r = buildHoursDriftReport({
      blobEntries: [entry({ totalHours: 8, ordinaryHours: 8 })],
      pgEntries: [entry({ totalHours: 8 + delta, ordinaryHours: 8 + delta })],
    });
    expect(r.summary.matchedCount).toBe(1);
    expect(r.summary.mismatchedCount).toBe(0);
    expect(r.summary.inSync).toBe(true);
  });

  it("surfaces duplicate business keys on each side as a drift signal", () => {
    const r = buildHoursDriftReport({
      blobEntries: [entry(), entry()], // same userKey+date twice
      pgEntries: [],
    });
    expect(r.summary.duplicateBlobKeys).toBe(1);
    expect(r.duplicateBlobKeys[0]!.key).toBe("u1|2026-06-01");
    expect(r.summary.inSync).toBe(false);
  });

  it("is in sync when both stores are empty", () => {
    const r = buildHoursDriftReport({ blobEntries: [], pgEntries: [] });
    expect(r.summary.inSync).toBe(true);
    expect(r.summary.driftHours).toBe(0);
  });

  it("buckets an unresolvable PG row (null userKey) separately — NOT as drift", () => {
    // A Postgres row whose user has a NULL legacy_user_id arrives with
    // userKey null. It must land in unresolvedPg, never in onlyInPg/duplicates.
    const r = buildHoursDriftReport({
      blobEntries: [],
      pgEntries: [entry({ userKey: null }), entry({ userKey: null, date: "2026-06-02" })],
    });
    expect(r.summary.unresolvedPgCount).toBe(2);
    expect(r.summary.onlyInPgCount).toBe(0);
    expect(r.summary.duplicatePgKeys).toBe(0);
    expect(r.summary.inSync).toBe(false);
  });

  it("flags duplicate business keys on the Postgres side", () => {
    const r = buildHoursDriftReport({
      blobEntries: [],
      pgEntries: [entry(), entry()], // same userKey+date twice
    });
    expect(r.summary.duplicatePgKeys).toBe(1);
    expect(r.duplicatePgKeys[0]!.key).toBe("u1|2026-06-01");
    expect(r.summary.inSync).toBe(false);
  });

  it("catches a status-only mismatch (identical hours)", () => {
    const r = buildHoursDriftReport({
      blobEntries: [entry({ status: "approved" })],
      pgEntries: [entry({ status: "submitted" })],
    });
    expect(r.summary.mismatchedCount).toBe(1);
    expect(r.mismatched[0]!.diffs).toEqual({ status: { blob: "approved", pg: "submitted" } });
  });

  it("catches an overtime-split mismatch when the total agrees", () => {
    const r = buildHoursDriftReport({
      blobEntries: [entry({ totalHours: 10, ordinaryHours: 10, overtimeHours: 0 })],
      pgEntries: [entry({ totalHours: 10, ordinaryHours: 8, overtimeHours: 2 })],
    });
    expect(r.summary.mismatchedCount).toBe(1);
    expect(r.mismatched[0]!.diffs).toMatchObject({
      ordinaryHours: { blob: 10, pg: 8 },
      overtimeHours: { blob: 0, pg: 2 },
    });
    expect(r.mismatched[0]!.diffs).not.toHaveProperty("totalHours");
  });

  it("gates on the tolerance in both directions (numeric(4,2) rounding never reads as drift)", () => {
    // A clear 0.02h gap drifts; a 0.005h gap (the most numeric(4,2) rounding can
    // contribute per value) does not. Exact-boundary (== 0.011) is left
    // untested on purpose — float representation makes it ambiguous and the
    // schema never produces a difference that close.
    const over = buildHoursDriftReport({
      blobEntries: [entry({ totalHours: 8 })],
      pgEntries: [entry({ totalHours: 8.02 })],
    });
    expect(over.summary.mismatchedCount).toBe(1);

    const under = buildHoursDriftReport({
      blobEntries: [entry({ totalHours: 8 })],
      pgEntries: [entry({ totalHours: 8.005 })],
    });
    expect(under.summary.mismatchedCount).toBe(0);
    expect(under.summary.inSync).toBe(true);
  });
});
