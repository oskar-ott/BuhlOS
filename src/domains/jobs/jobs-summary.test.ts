import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the Phil field jobs-summary projection (api/_lib/jobs-summary.js):
 *  - buildJobsSummary drops heavy structure + ALL money fields, keeps the
 *    field-kept superset, and pre-resolves typeName.
 *  - readJobsSummary is freshness-gated (never serves stale), rebuilds from the
 *    monolith on miss/stale, persists best-effort, and never throws on a write
 *    failure or a missing source.
 */
const requireFromHere = createRequire(import.meta.url);
const mod = requireFromHere("../../../api/_lib/jobs-summary.js") as {
  SUMMARY_KEY: string;
  SUMMARY_SOURCE_KEY: string;
  buildJobsSummary: (jobs: unknown[], jobTypes: unknown[]) => Array<Record<string, unknown>>;
  readJobsSummary: (deps: {
    readBlob: (key: string, fallback: unknown) => Promise<unknown>;
    readBlobFresh?: (key: string, fallback: unknown) => Promise<unknown>;
    writeBlob: (key: string, data: unknown) => Promise<unknown>;
    blobUploadedAt: (key: string) => Promise<string | null>;
  }) => Promise<{ records: Array<Record<string, unknown>>; source: string }>;
  countActiveSnagsV2: (dataDoc: unknown) => number;
  countActiveItps: (itpsDoc: unknown) => number;
  readFieldJobStats: (
    jobIds: string[],
    deps: { readBlob: (key: string, fallback: unknown) => Promise<unknown> }
  ) => Promise<Record<string, { statsSnagsV2Active: number; statsItpsActive: number }>>;
};
const {
  SUMMARY_KEY,
  SUMMARY_SOURCE_KEY,
  buildJobsSummary,
  readJobsSummary,
  countActiveSnagsV2,
  countActiveItps,
  readFieldJobStats,
} = mod;

describe("buildJobsSummary", () => {
  it("keeps field-kept fields, drops structure + money, resolves typeName", () => {
    const jobs = [
      {
        id: "j1",
        name: "Tower A",
        status: "active",
        ref: "JOB-001",
        siteAddress: "1 Smith St",
        scopeOfWork: [{ id: "s1", title: "DB-1" }],
        type: "t_resi",
        // heavy structure — must be dropped
        areaGroups: [{ id: "g", areas: [{ id: "a" }] }],
        roughInTasks: [{ id: "r1" }],
        fitOffTasks: [{ id: "f1" }],
        customFields: [{ id: "c1" }],
        temps: [{ id: "tmp" }],
        // money — must be dropped
        contractValue: 120000,
        labourEstimate: 40000,
        claimedToDate: 50000,
      },
    ];
    const rec = buildJobsSummary(jobs, [{ id: "t_resi", name: "Residential" }])[0]!;
    // kept
    expect(rec).toMatchObject({
      id: "j1",
      name: "Tower A",
      status: "active",
      ref: "JOB-001",
      siteAddress: "1 Smith St",
      typeName: "Residential",
    });
    expect(rec.scopeOfWork).toEqual([{ id: "s1", title: "DB-1" }]); // LH-redaction handles this downstream
    // dropped: structure
    for (const k of ["areaGroups", "roughInTasks", "fitOffTasks", "customFields", "temps"]) {
      expect(rec).not.toHaveProperty(k);
    }
    // dropped: money
    for (const k of ["contractValue", "labourEstimate", "claimedToDate"]) {
      expect(rec).not.toHaveProperty(k);
    }
  });

  it("omits typeName when the type has no matching job-type", () => {
    const rec = buildJobsSummary([{ id: "j", name: "N", type: "missing" }], [])[0]!;
    expect(rec).not.toHaveProperty("typeName");
  });

  it("tolerates empty / null inputs", () => {
    expect(buildJobsSummary([], [])).toEqual([]);
    expect(buildJobsSummary(null as unknown as unknown[], null as unknown as unknown[])).toEqual([]);
  });
});

function makeDeps(over: Partial<{ store: Map<string, unknown>; uploadedAt: string | null }> = {}) {
  const store = over.store ?? new Map<string, unknown>();
  const readBlob = vi.fn(async (key: string, fallback: unknown) =>
    store.has(key) ? store.get(key) : fallback
  );
  // Cache-skipping read used by the rebuild — same store here, but a separate
  // spy so a test can prove the SOURCE is read fresh (never the 5s-cached read).
  const readBlobFresh = vi.fn(async (key: string, fallback: unknown) =>
    store.has(key) ? store.get(key) : fallback
  );
  const writeBlob = vi.fn(async (key: string, data: unknown) => {
    store.set(key, data);
  });
  const blobUploadedAt = vi.fn(async (_key: string) =>
    "uploadedAt" in over ? (over.uploadedAt as string | null) : "T1"
  );
  return { store, readBlob, readBlobFresh, writeBlob, blobUploadedAt };
}

describe("readJobsSummary — freshness + fallback", () => {
  it("FRESH: builtFromUploadedAt matches → serves the summary, never reads the monolith", async () => {
    const store = new Map<string, unknown>([
      [SUMMARY_KEY, { builtFromUploadedAt: "T1", records: [{ id: "cached" }] }],
      [SUMMARY_SOURCE_KEY, { jobs: [{ id: "should-not-be-read" }] }],
    ]);
    const deps = makeDeps({ store, uploadedAt: "T1" });
    const out = await readJobsSummary(deps);
    expect(out).toEqual({ records: [{ id: "cached" }], source: "summary" });
    // the monolith was NOT fetched
    expect(deps.readBlob).not.toHaveBeenCalledWith(SUMMARY_SOURCE_KEY, expect.anything());
    expect(deps.writeBlob).not.toHaveBeenCalled();
  });

  it("STALE: builtFromUploadedAt mismatch → rebuilds from the monolith and re-stamps", async () => {
    const store = new Map<string, unknown>([
      [SUMMARY_KEY, { builtFromUploadedAt: "OLD", records: [{ id: "stale" }] }],
      [SUMMARY_SOURCE_KEY, { jobs: [{ id: "fresh", name: "Fresh", contractValue: 9 }] }],
      ["job-types.json", { jobTypes: [] }],
    ]);
    const deps = makeDeps({ store, uploadedAt: "T2" });
    const out = await readJobsSummary(deps);
    expect(out.source).toBe("rebuilt");
    expect(out.records).toEqual([{ id: "fresh", name: "Fresh" }]); // money dropped
    expect(deps.writeBlob).toHaveBeenCalledWith(SUMMARY_KEY, {
      builtFromUploadedAt: "T2",
      records: [{ id: "fresh", name: "Fresh" }],
    });
    // and the next read sees fresh data
    expect((store.get(SUMMARY_KEY) as { builtFromUploadedAt: string }).builtFromUploadedAt).toBe("T2");
  });

  it("REBUILD reads the SOURCE cache-skipping (readBlobFresh), never the 5s-cached read — no stale-stamped-fresh (#1036 class)", async () => {
    // Freshness stamp (uploadedAt) is sampled fresh; the records must be built
    // from a jobs.json read that is at least as new, or a just-created job can
    // be persisted-as-fresh yet missing from the field list until the next
    // write. So the rebuild's source read must go through the fresh reader.
    const store = new Map<string, unknown>([
      [SUMMARY_KEY, { builtFromUploadedAt: "OLD", records: [{ id: "stale" }] }],
      [SUMMARY_SOURCE_KEY, { jobs: [{ id: "j1", name: "One" }, { id: "j2", name: "Two just added" }] }],
      ["job-types.json", { jobTypes: [] }],
    ]);
    const deps = makeDeps({ store, uploadedAt: "T2" });
    const out = await readJobsSummary(deps);
    expect(out.source).toBe("rebuilt");
    // The source came through the cache-skipping reader…
    expect(deps.readBlobFresh).toHaveBeenCalledWith(SUMMARY_SOURCE_KEY, { jobs: [] });
    // …and NOT through the 5s-cached read (which could serve a stale monolith).
    expect(deps.readBlob).not.toHaveBeenCalledWith(SUMMARY_SOURCE_KEY, expect.anything());
    // The freshly-added job is present in the rebuilt records.
    expect(out.records.map((r) => r.id)).toEqual(["j1", "j2"]);
  });

  it("MISSING summary → rebuilds (first run)", async () => {
    const store = new Map<string, unknown>([
      [SUMMARY_SOURCE_KEY, { jobs: [{ id: "a", name: "A" }] }],
      ["job-types.json", { jobTypes: [] }],
    ]);
    const deps = makeDeps({ store, uploadedAt: "T1" });
    const out = await readJobsSummary(deps);
    expect(out.source).toBe("rebuilt");
    expect(out.records).toEqual([{ id: "a", name: "A" }]);
  });

  it("WRITE-FAIL: a persist failure still returns the freshly-built records (no throw)", async () => {
    const store = new Map<string, unknown>([
      [SUMMARY_SOURCE_KEY, { jobs: [{ id: "a", name: "A" }] }],
      ["job-types.json", { jobTypes: [] }],
    ]);
    const deps = makeDeps({ store, uploadedAt: "T1" });
    deps.writeBlob.mockRejectedValueOnce(new Error("blob write down"));
    const out = await readJobsSummary(deps);
    expect(out.records).toEqual([{ id: "a", name: "A" }]);
  });

  it("SOURCE uploadedAt null (jobs.json absent / list failed) → rebuilds empty, never stamps a bogus freshness", async () => {
    const store = new Map<string, unknown>(); // no jobs.json, no summary
    const deps = makeDeps({ store, uploadedAt: null });
    const out = await readJobsSummary(deps);
    expect(out.records).toEqual([]); // fallback {jobs:[]}
    expect(deps.writeBlob).not.toHaveBeenCalled(); // can't validate freshness → don't persist a stamp
  });
});

describe("countActiveSnagsV2 / countActiveItps — the two field stats", () => {
  it("counts active snagsV2 (open|in_progress|resolved|rejected); excludes verified/closed", () => {
    expect(
      countActiveSnagsV2({
        snagsV2: [
          { status: "open" },
          { status: "in_progress" },
          { status: "resolved" },
          { status: "rejected" },
          { status: "verified" },
          { status: "closed" },
        ],
      })
    ).toBe(4);
    expect(countActiveSnagsV2({})).toBe(0);
    expect(countActiveSnagsV2(null)).toBe(0);
  });

  it("counts active ITPs (pending|in-progress|witnessed, not archived); excludes completed/archived", () => {
    expect(
      countActiveItps({
        instances: [
          { status: "pending" },
          { status: "in-progress" },
          { status: "witnessed" },
          { status: "completed" },
          { status: "witnessed", archived: true },
        ],
      })
    ).toBe(3);
    expect(countActiveItps({})).toBe(0);
    expect(countActiveItps(null)).toBe(0);
  });
});

describe("readFieldJobStats — lightweight per-job stat reads", () => {
  it("reads ONLY data.json + itps.json per job and returns the two stats", async () => {
    const store = new Map<string, unknown>([
      ["jobs/a/data.json", { snagsV2: [{ status: "open" }, { status: "closed" }] }],
      ["jobs/a/itps.json", { instances: [{ status: "witnessed" }] }],
      ["jobs/b/data.json", { snagsV2: [] }],
      ["jobs/b/itps.json", { instances: [{ status: "pending" }, { status: "completed" }] }],
    ]);
    const read = new Set<string>();
    const readBlob = vi.fn(async (key: string, fallback: unknown) => {
      read.add(key);
      return store.has(key) ? store.get(key) : fallback;
    });
    const out = await readFieldJobStats(["a", "b"], { readBlob });
    expect(out).toEqual({
      a: { statsSnagsV2Active: 1, statsItpsActive: 1 },
      b: { statsSnagsV2Active: 0, statsItpsActive: 1 },
    });
    // never touches the monolith or any other blob
    expect([...read].sort()).toEqual([
      "jobs/a/data.json",
      "jobs/a/itps.json",
      "jobs/b/data.json",
      "jobs/b/itps.json",
    ]);
    expect(read.has("jobs.json")).toBe(false);
  });

  it("fails soft per job: a read error → {0,0}, never throws", async () => {
    const readBlob = vi.fn(async (key: string) => {
      if (key === "jobs/x/data.json") throw new Error("blob down");
      return { instances: [] };
    });
    const out = await readFieldJobStats(["x"], { readBlob });
    expect(out).toEqual({ x: { statsSnagsV2Active: 0, statsItpsActive: 0 } });
  });
});
