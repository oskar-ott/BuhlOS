import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

/**
 * J9 task-state dual-write mirror. Reconciles per-job task STATUS (data.json) →
 * Postgres tasks.status + an append-only task_status_event per REAL transition.
 * Best-effort, Blob-authoritative, off the request path (cron). Idempotent:
 * update + event only when blob status differs from pg status; replay writes 0.
 * Unknown statuses are rejected by the projection gate (quarantined), never coerced.
 */
const requireFromHere = createRequire(import.meta.url);
const p = requireFromHere.resolve("../../../api/_lib/task-mirror.js");
const { reconcileJobTasks, mirrorTasksIfEnabled, mirrorTasks } = requireFromHere(p) as {
  reconcileJobTasks: (sql: unknown, ctx: Ctx, jobLegacyId: string, job: unknown, data: unknown) => Promise<Recon>;
  mirrorTasksIfEnabled: (deps?: Record<string, unknown>) => Promise<{ ran: boolean; reason?: string }>;
  mirrorTasks: (deps?: Record<string, unknown>) => Promise<{ ran: boolean; reason?: string; error?: string }>;
};
const { compositeLegacyId } = requireFromHere(requireFromHere.resolve("../../../scripts/importers/lib/structure-legacy-id.js")) as { compositeLegacyId: (j: string, l: string) => string };

type Ctx = { tenantId: string; jobId: string; areaMap: Map<string, string>; nowIso: string };
type Recon = { quarantined?: boolean; reason?: string; issues?: Record<string, number>; attempted?: number; changed?: number; eventsInserted?: number; unresolved?: number };
type PgTask = { id: string; site_area_id: string; stage: string; legacy_template_id: string; status: string };

// A single-job blob with one area-override task t1 in roughIn, at `status`.
function jobAndData(status: string) {
  const job = { id: "j1", name: "Job 1", status: "active", areaGroups: [{ id: "g1", name: "G1", areas: [{ id: "a1", name: "A1", roughInTasks: [{ id: "t1", name: "T1" }] }] }], roughInTasks: [], fitOffTasks: [] };
  const data = { dwellings: { a1: { roughIn: { tasks: { t1: status } }, lastTouchedBy: "sparky" } }, snags: [], notes: [] };
  return { job, data };
}
const AA = compositeLegacyId("j1", "a1");
const ctx = (): Ctx => ({ tenantId: "T", jobId: "job-uuid", areaMap: new Map([[AA, "sa1"]]), nowIso: "2026-06-21T00:00:00.000Z" });

// Fake postgres.js: tagged-template + .begin + the sql(rows,...cols) insert form.
function fakeSql(pgTasks: PgTask[]) {
  const events: Array<Record<string, unknown>> = [];
  const updates: string[] = [];
  function tag(first: unknown, ...vals: unknown[]): unknown {
    // sql(rows, ...cols) insert-helper form (first arg = plain array, no `.raw`).
    if (Array.isArray(first) && !(first as { raw?: unknown }).raw) {
      events.push(...(first as Array<Record<string, unknown>>));
      return { __fragment: true };
    }
    const q = (first as string[]).join(" ");
    if (q.includes("from public.tasks")) return Promise.resolve(pgTasks);
    if (q.includes("update public.tasks")) {
      const to = vals[0] as string; const id = vals[2] as string;
      const t = pgTasks.find((r) => r.id === id);
      if (t && t.status !== to) { updates.push(id); t.status = to; return Promise.resolve([{ id }]); }
      return Promise.resolve([]);
    }
    return Promise.resolve([]); // the insert tagged-template itself
  }
  (tag as unknown as { begin: (fn: (tx: unknown) => unknown) => Promise<unknown> }).begin = async (fn) => fn(tag);
  return Object.assign(tag, { _events: events, _updates: updates });
}

describe("reconcileJobTasks", () => {
  it("status change → one UPDATE + one transition event (from→to)", async () => {
    const { job, data } = jobAndData("complete");
    const sql = fakeSql([{ id: "task1", site_area_id: "sa1", stage: "roughIn", legacy_template_id: "t1", status: "not_started" }]);
    const r = await reconcileJobTasks(sql, ctx(), "j1", job, data);
    expect(r).toMatchObject({ attempted: 1, changed: 1, eventsInserted: 1, unresolved: 0 });
    expect(sql._updates).toEqual(["task1"]);
    expect(sql._events[0]).toMatchObject({ task_id: "task1", from_status: "not_started", to_status: "complete", source: "mirror", actor_label: "sparky" });
  });

  it("idempotent: blob status already == pg status → 0 changes, 0 events", async () => {
    const { job, data } = jobAndData("complete");
    const sql = fakeSql([{ id: "task1", site_area_id: "sa1", stage: "roughIn", legacy_template_id: "t1", status: "complete" }]);
    const r = await reconcileJobTasks(sql, ctx(), "j1", job, data);
    expect(r).toMatchObject({ attempted: 1, changed: 0, eventsInserted: 0 });
    expect(sql._events).toHaveLength(0);
  });

  it("task not in Postgres yet → counted unresolved, no write", async () => {
    const { job, data } = jobAndData("complete");
    const sql = fakeSql([]); // no pg task
    const r = await reconcileJobTasks(sql, ctx(), "j1", job, data);
    expect(r).toMatchObject({ attempted: 1, changed: 0, eventsInserted: 0, unresolved: 1 });
  });

  it("unknown status → quarantined by the projection gate (never coerced, no sql)", async () => {
    const { job, data } = jobAndData("blocked"); // not in not_started/in_progress/complete
    const throwSql = () => { throw new Error("sql must not be called for a quarantined job"); };
    const r = await reconcileJobTasks(throwSql, ctx(), "j1", job, data);
    expect(r.quarantined).toBe(true);
    expect(r.issues?.badStatus).toBeGreaterThan(0);
  });
});

describe("mirrorTasksIfEnabled / mirrorTasks — gates + best-effort", () => {
  const OLD = process.env.SUPABASE_DB_URL;
  afterEach(() => { if (OLD === undefined) delete process.env.SUPABASE_DB_URL; else process.env.SUPABASE_DB_URL = OLD; });
  const throwDb = () => { throw new Error("getDb must not be called"); };

  it("no SUPABASE env → ran:false, db/flag untouched", async () => {
    delete process.env.SUPABASE_DB_URL;
    expect(await mirrorTasksIfEnabled({ getDb: throwDb, isFlagOn: async () => true })).toEqual({ ran: false, reason: "no supabase env" });
  });

  it("flag off → ran:false, db untouched", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    expect(await mirrorTasksIfEnabled({ getDb: throwDb, isFlagOn: async () => false })).toEqual({ ran: false, reason: "flag off" });
  });

  it("best-effort: getDb throws → mirrorTasks returns ran:false reason error, never throws", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await mirrorTasks({ isFlagOn: async () => true, getDb: () => { throw new Error("pooler down"); } });
    expect(r.ran).toBe(false);
    expect(r.reason).toBe("error");
    expect(r.error).toMatch(/pooler down/);
  });
});
