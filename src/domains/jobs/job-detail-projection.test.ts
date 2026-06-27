import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the Phil field SINGLE-JOB structure projection
 * (api/_lib/job-detail-projection.js):
 *  - buildJobDetailRecord drops ONLY the money (adminTier) fields, keeps the full
 *    structure + scopeOfWork (a leading hand reads it; redactJobForViewer strips it
 *    for plain field downstream).
 *  - readJobDetailProjection is freshness-gated (never serves stale), rebuilds the
 *    per-job blob from the monolith on miss/stale, persists best-effort, returns
 *    record:null when the job is absent (caller falls back), and never throws on a
 *    write failure or a missing source.
 */
const requireFromHere = createRequire(import.meta.url);
const mod = requireFromHere("../../../api/_lib/job-detail-projection.js") as {
  DETAIL_SOURCE_KEY: string;
  detailKey: (id: string) => string;
  MONEY_FIELDS: Set<string>;
  buildJobDetailRecord: (job: Record<string, unknown> | null) => Record<string, unknown> | null;
  readJobDetailProjection: (
    jobId: string,
    deps: {
      readBlob: (key: string, fallback: unknown) => Promise<unknown>;
      writeBlob: (key: string, data: unknown) => Promise<unknown>;
      blobUploadedAt: (key: string) => Promise<string | null>;
    }
  ) => Promise<{ record: Record<string, unknown> | null; source: string }>;
};
const { DETAIL_SOURCE_KEY, detailKey, MONEY_FIELDS, buildJobDetailRecord, readJobDetailProjection } = mod;

describe("MONEY_FIELDS — derived from redaction's adminTier audience", () => {
  it("covers exactly the commercial fields (so it can't drift from job-redaction)", () => {
    expect([...MONEY_FIELDS].sort()).toEqual(
      [
        "claimedToDate",
        // #228: client + contract commercial text — also adminTier, so the
        // drift-protected set sweeps them out of the field projection too.
        "clientReference",
        "contractNotes",
        "contractValue",
        "labourEstimate",
        "materialEstimate",
        "oldestClaimDays",
        "paidToDate",
      ].sort()
    );
  });
});

describe("buildJobDetailRecord", () => {
  it("keeps the full structure + scopeOfWork, drops every money field", () => {
    const job = {
      id: "j1",
      name: "Tower A",
      status: "active",
      ref: "JOB-001",
      siteAddress: "1 Smith St",
      scopeOfWork: [{ id: "s1", title: "DB-1" }], // LH reads it; kept here, redacted for field downstream
      type: "t_resi",
      modules: { plans: true },
      // full structure — must be KEPT (the detail page needs it)
      areaGroups: [{ id: "g", areas: [{ id: "a" }] }],
      roughInTasks: [{ id: "r1" }],
      fitOffTasks: [{ id: "f1" }],
      customFields: [{ id: "c1" }],
      temps: [{ id: "tmp" }],
      // money — must be dropped
      contractValue: 120000,
      labourEstimate: 40000,
      materialEstimate: 20000,
      claimedToDate: 50000,
      paidToDate: 30000,
      oldestClaimDays: 12,
    };
    const rec = buildJobDetailRecord(job)!;
    // kept: structure + scope + identity
    for (const k of ["id", "name", "status", "ref", "siteAddress", "type", "modules", "areaGroups", "roughInTasks", "fitOffTasks", "customFields", "temps"]) {
      expect(rec).toHaveProperty(k);
    }
    expect(rec.scopeOfWork).toEqual([{ id: "s1", title: "DB-1" }]);
    expect(rec.areaGroups).toEqual([{ id: "g", areas: [{ id: "a" }] }]);
    // dropped: every money field
    for (const k of ["contractValue", "labourEstimate", "materialEstimate", "claimedToDate", "paidToDate", "oldestClaimDays"]) {
      expect(rec).not.toHaveProperty(k);
    }
  });

  it("tolerates null / undefined", () => {
    expect(buildJobDetailRecord(null)).toBeNull();
    expect(buildJobDetailRecord(undefined as unknown as null)).toBeUndefined();
  });
});

function makeDeps(over: Partial<{ store: Map<string, unknown>; uploadedAt: string | null }> = {}) {
  const store = over.store ?? new Map<string, unknown>();
  const readBlob = vi.fn(async (key: string, fallback: unknown) =>
    store.has(key) ? store.get(key) : fallback
  );
  const writeBlob = vi.fn(async (key: string, data: unknown) => {
    store.set(key, data);
  });
  const blobUploadedAt = vi.fn(async (_key: string) =>
    "uploadedAt" in over ? (over.uploadedAt as string | null) : "T1"
  );
  return { store, readBlob, writeBlob, blobUploadedAt };
}

describe("readJobDetailProjection — freshness + fallback", () => {
  it("FRESH: builtFromUploadedAt matches → serves the per-job record, never reads the monolith", async () => {
    const store = new Map<string, unknown>([
      [detailKey("j1"), { builtFromUploadedAt: "T1", record: { id: "j1", name: "cached" } }],
      [DETAIL_SOURCE_KEY, { jobs: [{ id: "j1", name: "should-not-be-read" }] }],
    ]);
    const deps = makeDeps({ store, uploadedAt: "T1" });
    const out = await readJobDetailProjection("j1", deps);
    expect(out).toEqual({ record: { id: "j1", name: "cached" }, source: "detail" });
    expect(deps.readBlob).not.toHaveBeenCalledWith(DETAIL_SOURCE_KEY, expect.anything());
    expect(deps.writeBlob).not.toHaveBeenCalled();
  });

  it("STALE: builtFromUploadedAt mismatch → rebuilds from the monolith (money dropped) and re-stamps", async () => {
    const store = new Map<string, unknown>([
      [detailKey("j1"), { builtFromUploadedAt: "OLD", record: { id: "j1", name: "stale" } }],
      [DETAIL_SOURCE_KEY, { jobs: [
        { id: "other", name: "Other" },
        { id: "j1", name: "Fresh", contractValue: 9, areaGroups: [{ id: "g" }] },
      ] }],
    ]);
    const deps = makeDeps({ store, uploadedAt: "T2" });
    const out = await readJobDetailProjection("j1", deps);
    expect(out.source).toBe("rebuilt");
    expect(out.record).toEqual({ id: "j1", name: "Fresh", areaGroups: [{ id: "g" }] }); // money dropped, structure kept
    expect(deps.writeBlob).toHaveBeenCalledWith(detailKey("j1"), {
      builtFromUploadedAt: "T2",
      record: { id: "j1", name: "Fresh", areaGroups: [{ id: "g" }] },
    });
  });

  it("MISSING projection → rebuilds (first open of this job)", async () => {
    const store = new Map<string, unknown>([
      [DETAIL_SOURCE_KEY, { jobs: [{ id: "a", name: "A", areaGroups: [] }] }],
    ]);
    const deps = makeDeps({ store, uploadedAt: "T1" });
    const out = await readJobDetailProjection("a", deps);
    expect(out.source).toBe("rebuilt");
    expect(out.record).toEqual({ id: "a", name: "A", areaGroups: [] });
  });

  it("JOB NOT IN MONOLITH → record:null (caller falls back to the full read → 404)", async () => {
    const store = new Map<string, unknown>([
      [DETAIL_SOURCE_KEY, { jobs: [{ id: "a", name: "A" }] }],
    ]);
    const deps = makeDeps({ store, uploadedAt: "T1" });
    const out = await readJobDetailProjection("ghost", deps);
    expect(out).toEqual({ record: null, source: "rebuilt" });
    expect(deps.writeBlob).not.toHaveBeenCalled(); // nothing to persist
  });

  it("WRITE-FAIL: a persist failure still returns the freshly-built record (no throw)", async () => {
    const store = new Map<string, unknown>([
      [DETAIL_SOURCE_KEY, { jobs: [{ id: "a", name: "A" }] }],
    ]);
    const deps = makeDeps({ store, uploadedAt: "T1" });
    deps.writeBlob.mockRejectedValueOnce(new Error("blob write down"));
    const out = await readJobDetailProjection("a", deps);
    expect(out.record).toEqual({ id: "a", name: "A" });
  });

  it("SOURCE uploadedAt null (jobs.json absent / list failed) → rebuilds without stamping a bogus freshness", async () => {
    const store = new Map<string, unknown>([
      [DETAIL_SOURCE_KEY, { jobs: [{ id: "a", name: "A" }] }],
    ]);
    const deps = makeDeps({ store, uploadedAt: null });
    const out = await readJobDetailProjection("a", deps);
    expect(out.record).toEqual({ id: "a", name: "A" });
    expect(deps.writeBlob).not.toHaveBeenCalled(); // can't validate freshness → don't persist a stamp
  });

  it("CORRUPT projection (no .record) → treated as a miss, rebuilds", async () => {
    const store = new Map<string, unknown>([
      [detailKey("a"), { builtFromUploadedAt: "T1" /* no record */ }],
      [DETAIL_SOURCE_KEY, { jobs: [{ id: "a", name: "A" }] }],
    ]);
    const deps = makeDeps({ store, uploadedAt: "T1" });
    const out = await readJobDetailProjection("a", deps);
    expect(out.source).toBe("rebuilt");
    expect(out.record).toEqual({ id: "a", name: "A" });
  });
});
