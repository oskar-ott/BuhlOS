import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

/**
 * J10 Phil task-status read cutover. Parity-gated PG read at /api/data: serve task
 * statuses from PG only when byte-faithful to Blob for the whole job, else Blob.
 * Output is identical to Blob; a not-yet-mirrored toggle fails parity → Blob.
 * Best-effort, never throws. Reuses buildTaskProjection (no new identity).
 */
const requireFromHere = createRequire(import.meta.url);
const { readPhilTaskStatus } = requireFromHere(requireFromHere.resolve("../../../api/_lib/task-read.js")) as {
  readPhilTaskStatus: (input: Record<string, unknown>) => Promise<{ data: Data; diag: Diag }>;
};
const { compositeLegacyId } = requireFromHere(requireFromHere.resolve("../../../scripts/importers/lib/structure-legacy-id.js")) as { compositeLegacyId: (j: string, l: string) => string };

type Diag = { source: "blob" | "postgres"; reason: string; parityPass: boolean | null; matched: number; mismatched: number; orphans: number; unresolved: number; fallbackUsed: boolean; hashMatch: boolean | null };
type Data = { dwellings: Record<string, Record<string, { tasks: Record<string, string> }>>; snags: unknown[]; notes: unknown[] };

const job = { id: "j1", name: "Job 1", status: "active", areaGroups: [{ id: "g1", name: "G1", areas: [{ id: "a1", name: "A1", roughInTasks: [{ id: "t1", name: "T1" }] }] }], roughInTasks: [], fitOffTasks: [] };
const dataWith = (status: string): Data => ({ dwellings: { a1: { roughIn: { tasks: { t1: status } } } }, snags: [], notes: [] });
const AREAS = [{ id: "sa1", legacy_id: compositeLegacyId("j1", "a1") }];
const readBlob = async () => ({ jobs: [job] });

function fakeSql(pgRows: Array<Record<string, unknown>>, areaRows = AREAS) {
  return (first: unknown, ...rest: unknown[]) => {
    void rest;
    if (!Array.isArray(first)) return first; // sql(identifier) form (e.g. table name) → echo back
    const q = (first as string[]).join(" ");
    if (q.includes("from public.tenants")) return Promise.resolve([{ id: "T" }]);
    if (q.includes("select id from public.jobs")) return Promise.resolve([{ id: "job-uuid" }]);
    if (q.includes("select id, legacy_id from")) return Promise.resolve(areaRows); // legacyIdMap(site_areas)
    if (q.includes("from public.tasks")) return Promise.resolve(pgRows);
    return Promise.resolve([]);
  };
}
const pgTask = (status: string) => [{ site_area_id: "sa1", stage: "roughIn", legacy_template_id: "t1", status }];

const OLD = process.env.SUPABASE_DB_URL;
afterEach(() => { if (OLD === undefined) delete process.env.SUPABASE_DB_URL; else process.env.SUPABASE_DB_URL = OLD; });
const throwDb = () => { throw new Error("getDb must not be called"); };

describe("readPhilTaskStatus", () => {
  it("no SUPABASE env → Blob, db/flag untouched", async () => {
    delete process.env.SUPABASE_DB_URL;
    const r = await readPhilTaskStatus({ jobId: "j1", data: dataWith("complete"), getDb: throwDb, isFlagOn: async () => true, readBlob });
    expect(r.diag.source).toBe("blob");
    expect(r.diag.reason).toBe("no supabase env");
  });

  it("flag off → Blob, db untouched", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await readPhilTaskStatus({ jobId: "j1", data: dataWith("complete"), getDb: throwDb, isFlagOn: async () => false, readBlob });
    expect(r.diag.source).toBe("blob");
    expect(r.diag.reason).toBe("flag off");
  });

  it("parity PASS (PG == Blob) → served from Postgres, output identical", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const data = dataWith("complete");
    const r = await readPhilTaskStatus({ jobId: "j1", data, isFlagOn: async () => true, getDb: () => fakeSql(pgTask("complete")), readBlob });
    expect(r.diag.source).toBe("postgres");
    expect(r.diag.parityPass).toBe(true);
    expect(r.diag.matched).toBe(1);
    expect(r.data.dwellings.a1!.roughIn!.tasks.t1).toBe("complete"); // sourced from PG (== Blob)
  });

  it("parity FAIL (PG status drifts) → Blob fallback, never serves stale", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const data = dataWith("complete"); // worker just toggled to complete; PG still not_started
    const r = await readPhilTaskStatus({ jobId: "j1", data, isFlagOn: async () => true, getDb: () => fakeSql(pgTask("not_started")), readBlob });
    expect(r.diag.source).toBe("blob");
    expect(r.diag.parityPass).toBe(false);
    expect(r.diag.mismatched).toBe(1);
    expect(r.diag.fallbackUsed).toBe(true);
    expect(r.data.dwellings.a1!.roughIn!.tasks.t1).toBe("complete"); // worker sees their fresh Blob status
  });

  it("orphan PG task (not in blob projection) → parity fail → Blob", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const data = dataWith("complete");
    const rows = [...pgTask("complete"), { site_area_id: "sa1", stage: "roughIn", legacy_template_id: "ghost", status: "complete" }];
    const r = await readPhilTaskStatus({ jobId: "j1", data, isFlagOn: async () => true, getDb: () => fakeSql(rows), readBlob });
    expect(r.diag.source).toBe("blob");
    expect(r.diag.orphans).toBeGreaterThan(0);
  });

  it("best-effort: PG error → Blob fallback, never throws", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await readPhilTaskStatus({ jobId: "j1", data: dataWith("complete"), isFlagOn: async () => true, getDb: () => { throw new Error("pooler down"); }, readBlob });
    expect(r.diag.source).toBe("blob");
    expect(r.diag.reason).toBe("error");
    expect(r.diag.fallbackUsed).toBe(true);
  });
});
