import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

/**
 * J8 jobs structure dual-write mirror. Best-effort, Blob-authoritative, dark
 * behind supabase_dual_write_jobs. Mirrors ONE job's tenant/job/groups/areas/
 * templates via the SAME row-builder + upsert writer the bulk importer uses.
 * These cover the gates + best-effort guarantee with injected deps (no database);
 * the actual upsert is proven by the importer tests + the dev validation.
 */
const requireFromHere = createRequire(import.meta.url);
const p = requireFromHere.resolve("../../../api/_lib/jobs-mirror.js");
const { mirrorJobToPg } = requireFromHere(p) as {
  mirrorJobToPg: (jobId: string, deps?: Record<string, unknown>) => Promise<{ mirrored: boolean; reason?: string; error?: string }>;
};

const OLD = process.env.SUPABASE_DB_URL;
afterEach(() => { if (OLD === undefined) delete process.env.SUPABASE_DB_URL; else process.env.SUPABASE_DB_URL = OLD; });

const throwDb = () => { throw new Error("getDb must not be called"); };
const throwRead = () => { throw new Error("readBlob must not be called"); };
const cleanJob = { id: "j1", name: "Job 1", areaGroups: [], roughInTasks: [], fitOffTasks: [] };
const readWith = (jobs: unknown[]) => async () => ({ jobs });

describe("mirrorJobToPg — gates (production inert) + best-effort", () => {
  it("no jobId → skip, nothing touched", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    expect(await mirrorJobToPg("", { getDb: throwDb, readBlob: throwRead, isFlagOn: async () => true }))
      .toEqual({ mirrored: false, reason: "no jobId" });
  });

  it("no SUPABASE env → skip before the flag/db/blob are touched", async () => {
    delete process.env.SUPABASE_DB_URL;
    expect(await mirrorJobToPg("j1", { getDb: throwDb, readBlob: throwRead, isFlagOn: async () => { throw new Error("flag must not be read"); } }))
      .toEqual({ mirrored: false, reason: "no supabase env" });
  });

  it("flag off → skip, db/blob never touched", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    expect(await mirrorJobToPg("j1", { getDb: throwDb, readBlob: throwRead, isFlagOn: async () => false }))
      .toEqual({ mirrored: false, reason: "flag off" });
  });

  it("job not in Blob (hard-deleted / unknown) → skip, db never touched", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await mirrorJobToPg("j1", { getDb: throwDb, readBlob: readWith([{ id: "other" }]), isFlagOn: async () => true });
    expect(r).toEqual({ mirrored: false, reason: "job not in blob" });
  });

  it("quarantined structure (duplicate live area id) → skip, db never touched", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const dupJob = {
      id: "j1", name: "Job 1",
      areaGroups: [
        { id: "g1", name: "G1", areas: [{ id: "dup", name: "A" }] },
        { id: "g2", name: "G2", areas: [{ id: "dup", name: "B" }] }, // same live area id
      ],
      roughInTasks: [], fitOffTasks: [],
    };
    const r = await mirrorJobToPg("j1", { getDb: throwDb, readBlob: readWith([dupJob]), isFlagOn: async () => true });
    expect(r.mirrored).toBe(false);
    expect(r.reason).toBe("quarantined");
  });

  it("best-effort: a db error returns mirrored:false (never throws into the caller)", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await mirrorJobToPg("j1", {
      readBlob: readWith([cleanJob]),
      isFlagOn: async () => true,
      getDb: () => { throw new Error("pooler down"); },
    });
    expect(r.mirrored).toBe(false);
    expect(r.reason).toBe("error");
    expect(r.error).toMatch(/pooler down/);
  });

  it("best-effort: a slow/hung pooler times out → mirrored:false, never throws", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    // getDb returns an sql whose begin() never resolves → withTimeout fires.
    const hungSql = () => { const fn = () => new Promise(() => {}); fn.begin = () => new Promise(() => {}); return fn; };
    const r = await mirrorJobToPg("j1", {
      readBlob: readWith([cleanJob]),
      isFlagOn: async () => true,
      getDb: hungSql,
      timeoutMs: 20,
    });
    expect(r.mirrored).toBe(false);
    expect(r.reason).toBe("error");
  });
});
