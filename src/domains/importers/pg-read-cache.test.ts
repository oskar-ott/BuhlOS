import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Perf: process-local cache for the PG read overlays (J6/J7 jobs, J10/J11 task
 * status). The overlays re-ran the tenant lookup + mirror walk on EVERY read —
 * measured ~4s added to each admin /api/jobs read on prod (2026-07-03). Caching
 * the PG side is safe because the parity gate re-checks against the FRESH Blob
 * spine per request: a stale mirror can only fall back to Blob, never serve
 * stale data. These tests pin (1) the cache mechanics, (2) that the overlays
 * actually skip the PG walk on a warm cache, and (3) the load-bearing property
 * that a fresh Blob edit beats a cached mirror.
 */
const requireFromHere = createRequire(import.meta.url);

const cacheMod = requireFromHere(requireFromHere.resolve("../../../api/_lib/pg-read-cache.js")) as {
  createPgReadCache: () => PgReadCache;
  defaultPgReadCache: PgReadCache;
  PG_READ_TTL_MS: number;
};
type PgReadCache = {
  tenantId: (sql: unknown, slug: string) => Promise<string | null>;
  memoize: <T>(key: string, fn: () => Promise<T>, ttlMs?: number) => Promise<T>;
  _reset: () => void;
};

const jobsOverlayMod = requireFromHere(requireFromHere.resolve("../../../api/_lib/job-read-projection.js")) as {
  readAdminJobsWithPgOverlay: (input?: Record<string, unknown>) => Promise<{ jobs: Job[]; diag: JobsDiag }>;
  reconstructFromPg: (r: unknown) => { jobs: { jobs: Job[] } };
};
const taskReadMod = requireFromHere(requireFromHere.resolve("../../../api/_lib/task-read.js")) as {
  readAdminTaskStatus: (input: Record<string, unknown>) => Promise<{ data: Data; diag: TaskDiag }>;
};
const { compositeLegacyId } = requireFromHere(
  requireFromHere.resolve("../../../scripts/importers/lib/structure-legacy-id.js"),
) as { compositeLegacyId: (j: string, l: string) => string };

type Job = Record<string, unknown> & { id: string };
type JobsDiag = { readSource: "blob" | "postgres"; reason: string; pgFaithfulCount: number; driftedCount: number };
type TaskDiag = { source: "blob" | "postgres"; reason: string; parityPass: boolean | null; fallbackUsed: boolean };
type Data = { dwellings: Record<string, Record<string, { tasks: Record<string, string> }>>; snags: unknown[]; notes: unknown[] };

const OLD_URL = process.env.SUPABASE_DB_URL;
const OLD_DISABLE = process.env.PG_READ_CACHE_DISABLE;
afterEach(() => {
  if (OLD_URL === undefined) delete process.env.SUPABASE_DB_URL; else process.env.SUPABASE_DB_URL = OLD_URL;
  if (OLD_DISABLE === undefined) delete process.env.PG_READ_CACHE_DISABLE; else process.env.PG_READ_CACHE_DISABLE = OLD_DISABLE;
  vi.useRealTimers();
});

// ── the cache module itself ────────────────────────────────────────────────

function countingTenantSql(rows: Array<{ id: string }>) {
  const calls = { n: 0 };
  const sql = () => { calls.n += 1; return Promise.resolve(rows); };
  return { sql, calls };
}

describe("createPgReadCache — tenantId", () => {
  it("caches a found tenant for the process lifetime (second lookup = no query)", async () => {
    const cache = cacheMod.createPgReadCache();
    const { sql, calls } = countingTenantSql([{ id: "t1" }]);
    expect(await cache.tenantId(sql, "buhl")).toBe("t1");
    expect(await cache.tenantId(sql, "buhl")).toBe("t1");
    expect(calls.n).toBe(1);
  });

  it("does NOT cache a missing tenant (fail-open to the next lookup)", async () => {
    const cache = cacheMod.createPgReadCache();
    const { sql, calls } = countingTenantSql([]);
    expect(await cache.tenantId(sql, "buhl")).toBeNull();
    expect(await cache.tenantId(sql, "buhl")).toBeNull();
    expect(calls.n).toBe(2);
  });
});

describe("createPgReadCache — memoize", () => {
  it("returns the cached value inside the TTL, re-runs after expiry", async () => {
    vi.useFakeTimers();
    const cache = cacheMod.createPgReadCache();
    let n = 0;
    const fn = async () => { n += 1; return n; };
    expect(await cache.memoize("k", fn)).toBe(1);
    expect(await cache.memoize("k", fn)).toBe(1); // within TTL → cached
    vi.advanceTimersByTime(cacheMod.PG_READ_TTL_MS + 1);
    expect(await cache.memoize("k", fn)).toBe(2); // expired → re-run
  });

  it("caches null as a legitimate value (job-not-in-PG stays on Blob for the TTL)", async () => {
    const cache = cacheMod.createPgReadCache();
    let n = 0;
    const fn = async () => { n += 1; return null; };
    expect(await cache.memoize("k", fn)).toBeNull();
    expect(await cache.memoize("k", fn)).toBeNull();
    expect(n).toBe(1);
  });

  it("never caches an error (a failed walk retries on the next read)", async () => {
    const cache = cacheMod.createPgReadCache();
    let n = 0;
    const fn = async () => { n += 1; if (n === 1) throw new Error("pooler down"); return "ok"; };
    await expect(cache.memoize("k", fn)).rejects.toThrow("pooler down");
    expect(await cache.memoize("k", fn)).toBe("ok");
  });

  it("PG_READ_CACHE_DISABLE=1 → passthrough (operator escape hatch)", async () => {
    process.env.PG_READ_CACHE_DISABLE = "1";
    const cache = cacheMod.createPgReadCache();
    let n = 0;
    const fn = async () => { n += 1; return n; };
    expect(await cache.memoize("k", fn)).toBe(1);
    expect(await cache.memoize("k", fn)).toBe(2);
    const { sql, calls } = countingTenantSql([{ id: "t1" }]);
    await cache.tenantId(sql, "buhl");
    await cache.tenantId(sql, "buhl");
    expect(calls.n).toBe(2);
  });
});

// ── jobs overlay (J6) through the cache ────────────────────────────────────

function jobsPgRows() {
  const AG = compositeLegacyId("j1", "g1");
  const AA = compositeLegacyId("j1", "a1");
  return {
    jobs: [{ legacy_id: "j1", name: "Job 1", status: "active", ref: "R1", job_type_label: "new build", external_ref: "sm8", site_address: "1 St", site_contact_name: null, site_contact_phone: null, access_notes: null, parking_notes: null, safety_notes: null, induction_required: true, start_date: "2026-01-01", due_date: null, programmed_duration_days: 30, created_at: "2026-01-01 00:00:00+00" }],
    groups: [{ legacy_id: AG, job_legacy: "j1", name: "G1", sort_order: 0, archived: false }],
    areas: [{ legacy_id: AA, job_legacy: "j1", group_legacy: AG, name: "A1", space_type: "apt", sort_order: 1, archived: false }],
    templates: [],
    tasks: [],
    evidence: [],
  };
}

function countingJobsSql(data: ReturnType<typeof jobsPgRows>) {
  const calls = { tenant: 0, walk: 0 };
  const sql = (strings: TemplateStringsArray) => {
    const q = strings.join(" ");
    if (q.includes("from public.tenants")) { calls.tenant += 1; return Promise.resolve([{ id: "t1" }]); }
    calls.walk += 1;
    if (q.includes("from public.jobs where")) return Promise.resolve(data.jobs);
    if (q.includes("from public.site_area_groups")) return Promise.resolve(data.groups);
    if (q.includes("from public.site_areas a")) return Promise.resolve(data.areas);
    if (q.includes("from public.job_task_templates")) return Promise.resolve(data.templates);
    if (q.includes("from public.tasks t")) return Promise.resolve(data.tasks);
    if (q.includes("from public.evidence_files")) return Promise.resolve(data.evidence);
    return Promise.resolve([]);
  };
  return { sql, calls };
}

function faithfulBlobJobs(): Job[] {
  return jobsOverlayMod.reconstructFromPg(jobsPgRows()).jobs.jobs.map((j) => ({ ...j, modules: { areas: true } }));
}

describe("readAdminJobsWithPgOverlay — pgCache", () => {
  it("second read on a warm cache runs ZERO PG queries and still serves from Postgres", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const cache = cacheMod.createPgReadCache();
    const { sql, calls } = countingJobsSql(jobsPgRows());
    const input = () => ({ blobJobs: faithfulBlobJobs(), isFlagOn: async () => true, getDb: () => sql, pgCache: cache });
    const r1 = await jobsOverlayMod.readAdminJobsWithPgOverlay(input());
    expect(r1.diag.readSource).toBe("postgres");
    const after1 = { ...calls };
    const r2 = await jobsOverlayMod.readAdminJobsWithPgOverlay(input());
    expect(r2.diag.readSource).toBe("postgres");
    expect(r2.diag.pgFaithfulCount).toBe(1);
    expect(calls).toEqual(after1); // no new tenant lookup, no new walk
  });

  it("LOAD-BEARING: a fresh Blob edit beats the cached mirror (drift → Blob served)", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const cache = cacheMod.createPgReadCache();
    const { sql } = countingJobsSql(jobsPgRows());
    const base = { isFlagOn: async () => true, getDb: () => sql, pgCache: cache };
    // Warm the cache with a faithful read…
    const r1 = await jobsOverlayMod.readAdminJobsWithPgOverlay({ ...base, blobJobs: faithfulBlobJobs() });
    expect(r1.diag.readSource).toBe("postgres");
    // …then the office edits the job in Blob. The cached mirror is now stale.
    const edited = faithfulBlobJobs().map((j) => ({ ...j, status: "complete" }));
    const r2 = await jobsOverlayMod.readAdminJobsWithPgOverlay({ ...base, blobJobs: edited });
    expect(r2.diag.driftedCount).toBe(1);
    expect(r2.jobs[0]!.status).toBe("complete"); // fresh Blob wins, never the stale mirror
    expect(r2.jobs).toEqual(edited);
  });

  it("injected getDb WITHOUT pgCache → shared cache stays off (every call queries)", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const { sql, calls } = countingJobsSql(jobsPgRows());
    const input = () => ({ blobJobs: faithfulBlobJobs(), isFlagOn: async () => true, getDb: () => sql });
    await jobsOverlayMod.readAdminJobsWithPgOverlay(input());
    await jobsOverlayMod.readAdminJobsWithPgOverlay(input());
    expect(calls.tenant).toBe(2); // no caching between calls
  });
});

// ── task-status overlay (J11) through the cache ────────────────────────────

const taskJob = { id: "j1", name: "Job 1", status: "active", areaGroups: [{ id: "g1", name: "G1", areas: [{ id: "a1", name: "A1", roughInTasks: [{ id: "t1", name: "T1" }] }] }], roughInTasks: [], fitOffTasks: [] };
const taskData = (status: string): Data => ({ dwellings: { a1: { roughIn: { tasks: { t1: status } } } }, snags: [], notes: [] });
const TASK_AREAS = [{ id: "sa1", legacy_id: compositeLegacyId("j1", "a1") }];
const taskReadBlob = async () => ({ jobs: [taskJob] });

function countingTaskSql(pgRows: Array<Record<string, unknown>>) {
  const calls = { n: 0 };
  const sql = (first: unknown, ...rest: unknown[]) => {
    void rest;
    if (!Array.isArray(first)) return first; // sql(identifier) form → echo back
    calls.n += 1;
    const q = (first as string[]).join(" ");
    if (q.includes("from public.tenants")) return Promise.resolve([{ id: "T" }]);
    if (q.includes("select id from public.jobs")) return Promise.resolve([{ id: "job-uuid" }]);
    if (q.includes("select id, legacy_id from")) return Promise.resolve(TASK_AREAS);
    if (q.includes("from public.tasks")) return Promise.resolve(pgRows);
    return Promise.resolve([]);
  };
  return { sql, calls };
}
const pgTask = (status: string) => [{ site_area_id: "sa1", stage: "roughIn", legacy_template_id: "t1", status }];

describe("readAdminTaskStatus — pgCache", () => {
  it("second read on a warm cache runs ZERO PG queries and still serves from Postgres", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const cache = cacheMod.createPgReadCache();
    const { sql, calls } = countingTaskSql(pgTask("complete"));
    const input = () => ({ jobId: "j1", data: taskData("complete"), isFlagOn: async () => true, getDb: () => sql, readBlob: taskReadBlob, pgCache: cache });
    const r1 = await taskReadMod.readAdminTaskStatus(input());
    expect(r1.diag.source).toBe("postgres");
    const after1 = calls.n;
    const r2 = await taskReadMod.readAdminTaskStatus(input());
    expect(r2.diag.source).toBe("postgres");
    expect(r2.data.dwellings.a1!.roughIn!.tasks.t1).toBe("complete");
    expect(calls.n).toBe(after1); // no new queries
  });

  it("LOAD-BEARING: a fresh Blob toggle beats cached task rows (parity fail → Blob)", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const cache = cacheMod.createPgReadCache();
    const { sql } = countingTaskSql(pgTask("not_started"));
    const base = { jobId: "j1", isFlagOn: async () => true, getDb: () => sql, readBlob: taskReadBlob, pgCache: cache };
    // Warm the cache while PG == Blob (both not_started)…
    const r1 = await taskReadMod.readAdminTaskStatus({ ...base, data: taskData("not_started") });
    expect(r1.diag.source).toBe("postgres");
    // …then the worker toggles the task in Blob; the cached rows are stale.
    const r2 = await taskReadMod.readAdminTaskStatus({ ...base, data: taskData("complete") });
    expect(r2.diag.source).toBe("blob");
    expect(r2.diag.parityPass).toBe(false);
    expect(r2.diag.fallbackUsed).toBe(true);
    expect(r2.data.dwellings.a1!.roughIn!.tasks.t1).toBe("complete"); // fresh Blob status
  });
});
