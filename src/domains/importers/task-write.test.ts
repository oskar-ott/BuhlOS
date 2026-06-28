import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Task-status PG-as-source write (Stage A). writeTaskStatusToPg does a synchronous
 * per-row CAS update of public.tasks.status (+ one append-only task_status_event)
 * behind `supabase_source_tasks`. Best-effort: gates on env + flag, returns
 * {pg:false,reason} when it can't write (so the caller falls back to the Blob
 * write). Per-row update is the lost-update fix; idempotent on no-op.
 */
const requireFromHere = createRequire(import.meta.url);
const { writeTaskStatusToPg } = requireFromHere(requireFromHere.resolve("../../../api/_lib/task-write.js")) as {
  writeTaskStatusToPg: (input: Record<string, unknown>) => Promise<{ pg: boolean; changed?: boolean; reason?: string; error?: string }>;
};

type Task = { id: string; status: string };
// Fake postgres.js: tagged-template + .begin + the sql(rows,...cols) insert form.
function fakeSql(opts: { task?: Task | null; area?: Array<{ id: string }>; job?: Array<{ id: string }> } = {}) {
  const task = opts.task === undefined ? { id: "task1", status: "not_started" } : opts.task;
  const area = opts.area === undefined ? [{ id: "sa1" }] : opts.area;
  const job = opts.job === undefined ? [{ id: "job-uuid" }] : opts.job;
  const events: Array<Record<string, unknown>> = [];
  const updates: string[] = [];
  function tag(first: unknown, ...vals: unknown[]): unknown {
    if (Array.isArray(first) && !(first as { raw?: unknown }).raw) { events.push(...(first as Array<Record<string, unknown>>)); return { __fragment: true }; }
    const q = (first as string[]).join(" ");
    if (q.includes("from public.tenants")) return Promise.resolve([{ id: "T" }]);
    if (q.includes("from public.jobs")) return Promise.resolve(job);
    if (q.includes("from public.site_areas")) return Promise.resolve(area);
    if (q.includes("from public.tasks")) return Promise.resolve(task ? [task] : []);
    if (q.includes("update public.tasks")) {
      const to = vals[0] as string; // status IS DISTINCT FROM ${state}
      if (task && task.status !== to) { updates.push(task.id); return Promise.resolve([{ id: task.id }]); }
      return Promise.resolve([]);
    }
    return Promise.resolve([]); // the insert tagged-template itself
  }
  (tag as unknown as { begin: (fn: (tx: unknown) => unknown) => Promise<unknown> }).begin = async (fn) => fn(tag);
  return Object.assign(tag, { _events: events, _updates: updates });
}
const base = { jobId: "j1", areaId: "a1", stage: "roughIn", taskId: "t1", actorLabel: "sparky" };
const throwDb = () => { throw new Error("getDb must not be called"); };

const OLD = process.env.SUPABASE_DB_URL;
afterEach(() => { if (OLD === undefined) delete process.env.SUPABASE_DB_URL; else process.env.SUPABASE_DB_URL = OLD; });

describe("writeTaskStatusToPg (PG-as-source Stage A)", () => {
  it("no SUPABASE env → pg:false, db/flag untouched", async () => {
    delete process.env.SUPABASE_DB_URL;
    const r = await writeTaskStatusToPg({ ...base, state: "complete", getDb: throwDb, isFlagOn: async () => true });
    expect(r).toEqual({ pg: false, reason: "no supabase env" });
  });

  it("flag off → pg:false, db untouched", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await writeTaskStatusToPg({ ...base, state: "complete", getDb: throwDb, isFlagOn: async () => false });
    expect(r).toEqual({ pg: false, reason: "flag off" });
  });

  it("status differs → CAS update + ONE status event, changed:true", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const sql = fakeSql({ task: { id: "task1", status: "not_started" } });
    const r = await writeTaskStatusToPg({ ...base, state: "complete", isFlagOn: async () => true, getDb: () => sql });
    expect(r).toEqual({ pg: true, changed: true });
    expect(sql._updates).toEqual(["task1"]);
    expect(sql._events).toHaveLength(1);
    expect(sql._events[0]).toMatchObject({ task_id: "task1", from_status: "not_started", to_status: "complete", source: "toggle", actor_label: "sparky" });
  });

  it("already at target status → no-op, changed:false, no event", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const sql = fakeSql({ task: { id: "task1", status: "complete" } });
    const r = await writeTaskStatusToPg({ ...base, state: "complete", isFlagOn: async () => true, getDb: () => sql });
    expect(r).toEqual({ pg: true, changed: false });
    expect(sql._events).toHaveLength(0);
  });

  it("task not mirrored in PG → pg:false reason 'task not in pg' (caller falls back to Blob)", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await writeTaskStatusToPg({ ...base, state: "complete", isFlagOn: async () => true, getDb: () => fakeSql({ task: null }) });
    expect(r).toEqual({ pg: false, reason: "task not in pg" });
  });

  it("area not mirrored → pg:false reason 'area not in pg'", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await writeTaskStatusToPg({ ...base, state: "complete", isFlagOn: async () => true, getDb: () => fakeSql({ area: [] }) });
    expect(r).toEqual({ pg: false, reason: "area not in pg" });
  });

  it("best-effort: a PG error → pg:false reason 'error', never throws", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await writeTaskStatusToPg({ ...base, state: "complete", isFlagOn: async () => true, getDb: () => { throw new Error("pooler down"); } });
    expect(r.pg).toBe(false);
    expect(r.reason).toBe("error");
  });
});
