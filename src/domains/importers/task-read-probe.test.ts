import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

/**
 * J12 cutover-readiness probe. probeTaskReadParity runs the SAME parity engine
 * read-only (flag forced ON) across a bounded sample of jobs and aggregates how
 * byte-faithful the PG mirror is to Blob — NO serving, NO writes, never throws.
 * Also pins the module's export surface: the raw engine stays internal.
 */
const requireFromHere = createRequire(import.meta.url);
const taskRead = requireFromHere(requireFromHere.resolve("../../../api/_lib/task-read.js")) as {
  probeTaskReadParity: (input: Record<string, unknown>) => Promise<Probe>;
  readPhilTaskStatus: unknown;
  readAdminTaskStatus: unknown;
  readTaskStatusOverlay?: unknown;
};
const { probeTaskReadParity } = taskRead;
const { compositeLegacyId } = requireFromHere(requireFromHere.resolve("../../../scripts/importers/lib/structure-legacy-id.js")) as { compositeLegacyId: (j: string, l: string) => string };

type Probe = {
  wired: boolean; jobsTotal: number; jobsSampled: number;
  pgFaithful: number; drifted: number; errored: number; unavailable: number;
  totalMismatched: number; totalUnresolved: number; totalOrphans: number; hashDriftJobs: number;
  latencyMs: number; error: string | null;
};
type Data = { dwellings: Record<string, Record<string, { tasks: Record<string, string> }>>; snags: unknown[]; notes: unknown[] };

const jobRec = (id: string) => ({ id, name: id, status: "active", areaGroups: [{ id: "g1", name: "G1", areas: [{ id: "a1", name: "A1", roughInTasks: [{ id: "t1", name: "T1" }] }] }], roughInTasks: [], fitOffTasks: [] });
const dataWith = (status: string): Data => ({ dwellings: { a1: { roughIn: { tasks: { t1: status } } } }, snags: [], notes: [] });
const areasFor = (jobId: string) => [{ id: "sa1", legacy_id: compositeLegacyId(jobId, "a1") }];
const pgTask = (status: string) => [{ site_area_id: "sa1", stage: "roughIn", legacy_template_id: "t1", status }];

// readBlob that serves jobs.json + per-job data.json (the probe reads both).
function readBlobFor(jobs: ReturnType<typeof jobRec>[], dataByJob: Record<string, Data>) {
  return async (key: string, fallback?: unknown) => {
    if (key === "jobs.json") return { jobs };
    const m = /^jobs\/(.+)\/data\.json$/.exec(key);
    if (m && m[1]) return dataByJob[m[1]] ?? fallback;
    return fallback;
  };
}
// sql keyed to ONE job (returns its job-uuid + area map + given pgRows).
function fakeSql(jobId: string, pgRows: Array<Record<string, unknown>>) {
  return () => (first: unknown, ...rest: unknown[]) => {
    void rest;
    if (!Array.isArray(first)) return first; // sql(identifier) → echo
    const q = (first as string[]).join(" ");
    if (q.includes("from public.tenants")) return Promise.resolve([{ id: "T" }]);
    if (q.includes("select id from public.jobs")) return Promise.resolve([{ id: "job-uuid" }]);
    if (q.includes("select id, legacy_id from")) return Promise.resolve(areasFor(jobId));
    if (q.includes("from public.tasks")) return Promise.resolve(pgRows);
    return Promise.resolve([]);
  };
}

const OLD = process.env.SUPABASE_DB_URL;
afterEach(() => { if (OLD === undefined) delete process.env.SUPABASE_DB_URL; else process.env.SUPABASE_DB_URL = OLD; });

describe("probeTaskReadParity (J12 readiness)", () => {
  it("no SUPABASE env → not wired, nothing sampled", async () => {
    delete process.env.SUPABASE_DB_URL;
    const r = await probeTaskReadParity({ getDb: () => { throw new Error("must not connect"); }, readBlob: readBlobFor([jobRec("j1")], { j1: dataWith("complete") }) });
    expect(r.wired).toBe(false);
    expect(r.jobsSampled).toBe(0);
  });

  it("a byte-faithful job → counted pgFaithful, no drift", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await probeTaskReadParity({ getDb: fakeSql("j1", pgTask("complete")), readBlob: readBlobFor([jobRec("j1")], { j1: dataWith("complete") }) });
    expect(r.wired).toBe(true);
    expect(r.jobsTotal).toBe(1);
    expect(r.jobsSampled).toBe(1);
    expect(r.pgFaithful).toBe(1);
    expect(r.drifted).toBe(0);
    expect(r.errored).toBe(0);
    expect(r.unavailable).toBe(0);
  });

  it("a drifted job (PG status differs) → counted drifted with breakdown", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await probeTaskReadParity({ getDb: fakeSql("j1", pgTask("not_started")), readBlob: readBlobFor([jobRec("j1")], { j1: dataWith("complete") }) });
    expect(r.pgFaithful).toBe(0);
    expect(r.drifted).toBe(1);
    expect(r.totalMismatched).toBe(1);
    expect(r.hashDriftJobs).toBe(1);
  });

  it("PG unreachable for a job → counted errored, never throws", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await probeTaskReadParity({ getDb: () => { throw new Error("pooler down"); }, readBlob: readBlobFor([jobRec("j1")], { j1: dataWith("complete") }) });
    expect(r.errored).toBe(1);
    expect(r.drifted).toBe(0);
    expect(r.error).toBeNull(); // per-job error, not a probe-level failure
  });

  it("job not yet in PG → counted unavailable", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const noJob = () => (first: unknown) => {
      if (!Array.isArray(first)) return first;
      const q = (first as string[]).join(" ");
      if (q.includes("from public.tenants")) return Promise.resolve([{ id: "T" }]);
      if (q.includes("select id from public.jobs")) return Promise.resolve([]); // not in PG
      return Promise.resolve([]);
    };
    const r = await probeTaskReadParity({ getDb: noJob, readBlob: readBlobFor([jobRec("j1")], { j1: dataWith("complete") }) });
    expect(r.unavailable).toBe(1);
    expect(r.drifted).toBe(0);
    expect(r.pgFaithful).toBe(0);
  });

  it("bounds the sample and reports the truncation (no silent cap)", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const jobs = [jobRec("j1"), jobRec("j2"), jobRec("j3")];
    const r = await probeTaskReadParity({ sampleLimit: 1, getDb: fakeSql("j1", pgTask("complete")), readBlob: readBlobFor(jobs, { j1: dataWith("complete") }) });
    expect(r.jobsTotal).toBe(3);
    expect(r.jobsSampled).toBe(1);
  });

  it("best-effort: a jobs.json read failure → error reported, never throws", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await probeTaskReadParity({ getDb: fakeSql("j1", pgTask("complete")), readBlob: async () => { throw new Error("blob down"); } });
    expect(r.error).toBe("blob down");
    expect(r.jobsSampled).toBe(0);
  });
});

describe("task-read.js export surface (J12 guardrail)", () => {
  it("exports only the audience wrappers + the probe; the raw engine is internal", () => {
    expect(typeof taskRead.readPhilTaskStatus).toBe("function");
    expect(typeof taskRead.readAdminTaskStatus).toBe("function");
    expect(typeof taskRead.probeTaskReadParity).toBe("function");
    expect(taskRead.readTaskStatusOverlay).toBeUndefined(); // un-exported in J12
  });
});
