import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

/**
 * J11 admin task-status read cutover. readAdminTaskStatus is the SAME parity engine
 * as the J10 Phil read (exhaustively tested in task-read.test.ts) behind a DIFFERENT
 * flag — supabase_read_admin_tasks. These tests prove the admin AUDIENCE seam:
 * the admin wrapper gates on the admin flag (NOT the Phil flag), and otherwise
 * inherits the parity-gated, Blob-authoritative behaviour. Output is identical to
 * Blob; a not-yet-mirrored toggle fails parity → Blob. Best-effort, never throws.
 */
const requireFromHere = createRequire(import.meta.url);
const { readAdminTaskStatus } = requireFromHere(requireFromHere.resolve("../../../api/_lib/task-read.js")) as {
  readAdminTaskStatus: (input: Record<string, unknown>) => Promise<{ data: Data; diag: Diag }>;
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
    if (q.includes("select id, legacy_id from")) return Promise.resolve(areaRows);
    if (q.includes("from public.tasks")) return Promise.resolve(pgRows);
    return Promise.resolve([]);
  };
}
const pgTask = (status: string) => [{ site_area_id: "sa1", stage: "roughIn", legacy_template_id: "t1", status }];

const OLD = process.env.SUPABASE_DB_URL;
afterEach(() => { if (OLD === undefined) delete process.env.SUPABASE_DB_URL; else process.env.SUPABASE_DB_URL = OLD; });
const throwDb = () => { throw new Error("getDb must not be called"); };

describe("readAdminTaskStatus (J11)", () => {
  it("no SUPABASE env → Blob, db/flag untouched", async () => {
    delete process.env.SUPABASE_DB_URL;
    const r = await readAdminTaskStatus({ jobId: "j1", data: dataWith("complete"), getDb: throwDb, isFlagOn: async () => true, readBlob });
    expect(r.diag.source).toBe("blob");
    expect(r.diag.reason).toBe("no supabase env");
  });

  it("gates on the ADMIN flag, not the Phil flag (audience separation)", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const seen: string[] = [];
    // Phil flag ON, admin flag OFF: the admin read must stay on Blob.
    const isFlagOn = async (k: string) => { seen.push(k); return k === "supabase_read_phil_tasks"; };
    const r = await readAdminTaskStatus({ jobId: "j1", data: dataWith("complete"), getDb: throwDb, isFlagOn, readBlob });
    expect(seen).toEqual(["supabase_read_admin_tasks"]); // the wrapper pins the admin flag
    expect(r.diag.source).toBe("blob");
    expect(r.diag.reason).toBe("flag off");
  });

  it("admin flag ON + parity PASS (PG == Blob) → served from Postgres, output identical", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await readAdminTaskStatus({ jobId: "j1", data: dataWith("complete"), isFlagOn: async (k: string) => k === "supabase_read_admin_tasks", getDb: () => fakeSql(pgTask("complete")), readBlob });
    expect(r.diag.source).toBe("postgres");
    expect(r.diag.parityPass).toBe(true);
    expect(r.data.dwellings.a1!.roughIn!.tasks.t1).toBe("complete");
  });

  it("admin flag ON + parity FAIL (PG drifts) → Blob fallback, never serves stale", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const data = dataWith("complete"); // office change reflected in Blob; PG still behind
    const r = await readAdminTaskStatus({ jobId: "j1", data, isFlagOn: async (k: string) => k === "supabase_read_admin_tasks", getDb: () => fakeSql(pgTask("not_started")), readBlob });
    expect(r.diag.source).toBe("blob");
    expect(r.diag.parityPass).toBe(false);
    expect(r.diag.fallbackUsed).toBe(true);
    expect(r.data.dwellings.a1!.roughIn!.tasks.t1).toBe("complete"); // fresh Blob status
  });

  it("best-effort: PG error → Blob fallback, never throws", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await readAdminTaskStatus({ jobId: "j1", data: dataWith("complete"), isFlagOn: async (k: string) => k === "supabase_read_admin_tasks", getDb: () => { throw new Error("pooler down"); }, readBlob });
    expect(r.diag.source).toBe("blob");
    expect(r.diag.reason).toBe("error");
    expect(r.diag.fallbackUsed).toBe(true);
  });
});
