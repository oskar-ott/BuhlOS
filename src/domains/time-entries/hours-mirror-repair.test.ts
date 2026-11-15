import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

/**
 * Hours mirror REPAIR (2026-10-11). Production had 67 approved days still
 * "submitted" in Postgres and a split day without allocations; the live mirror
 * is one-shot. The sweep re-mirrors drifted days from the Blob truth — never
 * over a day still settling in the CDN window, never deleting what it couldn't
 * read, never mass-deleting.
 */
const requireFromHere = createRequire(import.meta.url);
const { repairHoursMirror, SETTLE_MS, MAX_DELETES } = requireFromHere("../../../api/_lib/hours-repair.js");
const { handleMirrorHours } = requireFromHere("../../../api/internal/mirror-hours.js");

const NOW = Date.parse("2026-10-11T00:00:00Z");
const OLD = new Date(NOW - 60 * 60 * 1000).toISOString();
const FRESH = new Date(NOW - 60 * 1000).toISOString();

type Entry = { totalHours: number; ordinaryHours: number; overtimeHours: number; status: string; allocations: Array<{ jobId: string; hours: number }> };
const day = (status: string, allocations = [{ jobId: "job-a", hours: 7.6 }]): Entry => ({ totalHours: 7.6, ordinaryHours: 7.6, overtimeHours: 0, status, allocations });

function sqlStub() {
  return (async () => [{ id: "tenant-1" }]) as unknown as (s: TemplateStringsArray) => Promise<unknown[]>;
}

function world(blob: Record<string, { e: Entry; uploadedAt?: string } | "unreadable">, pg: Record<string, Entry>) {
  const { normaliseEntry } = requireFromHere("../../../api/_lib/hours-sync-report.js");
  const byKey = new Map();
  const entries: unknown[] = [];
  const unreadable: string[] = [];
  for (const [key, v] of Object.entries(blob)) {
    const [userId, date] = key.split("|");
    if (v === "unreadable") { unreadable.push(key); continue; }
    entries.push(normaliseEntry(userId, date, v.e));
    byKey.set(key, { userId, date, raw: v.e, uploadedAt: v.uploadedAt ?? OLD });
  }
  const mirror = vi.fn(async (_userId: string, _entry: Entry): Promise<Record<string, unknown>> => ({ mirrored: true }));
  const mirrorDelete = vi.fn(async (_userId: string, _date: string): Promise<Record<string, unknown>> => ({ mirrored: true }));
  const deps = {
    loadBlob: async () => ({ entries, byKey, unreadable, listedKeys: Object.keys(blob) }),
    loadPg: async () => Object.entries(pg).map(([key, e]) => { const [userId, date] = key.split("|"); return { userId, date, ...e }; }),
    mirror,
    mirrorDelete,
  };
  return { deps, mirror, mirrorDelete };
}

describe("repairHoursMirror", () => {
  it("re-mirrors the drifted days from the Blob truth — status and lost allocations", async () => {
    const { deps, mirror } = world(
      {
        "u1|2026-09-21": { e: day("approved") },
        "u2|2026-10-07": { e: day("approved", [{ jobId: "job-a", hours: 4 }, { jobId: "job-b", hours: 3.6 }]) },
        "u3|2026-10-01": { e: day("approved") },
      },
      {
        "u1|2026-09-21": day("submitted"),
        "u2|2026-10-07": day("approved", []),
        "u3|2026-10-01": day("approved"),
      },
    );
    const out = await repairHoursMirror(sqlStub(), { apply: true, deps, now: NOW });
    expect(out).toMatchObject({ mismatched: 2, toWrite: 2, repaired: 2, deleted: 0, failedCount: 0 });
    expect(mirror.mock.calls.map((c) => [c[0], c[1].status])).toEqual([["u1", "approved"], ["u2", "approved"]]);
  });

  it("a dry run writes nothing and returns the plan", async () => {
    const { deps, mirror, mirrorDelete } = world({ "u1|2026-09-21": { e: day("approved") } }, { "u1|2026-09-21": day("submitted") });
    const out = await repairHoursMirror(sqlStub(), { apply: false, deps, now: NOW });
    expect(out).toMatchObject({ apply: false, toWrite: 1 });
    expect(out.keys.write).toEqual(["u1|2026-09-21"]);
    expect(mirror).not.toHaveBeenCalled();
    expect(mirrorDelete).not.toHaveBeenCalled();
  });

  it("never writes a day still settling in the CDN window — its fetched copy may be the old one", async () => {
    const { deps, mirror } = world(
      { "u1|2026-10-10": { e: day("approved"), uploadedAt: FRESH } },
      { "u1|2026-10-10": day("submitted") },
    );
    const out = await repairHoursMirror(sqlStub(), { apply: true, deps, now: NOW });
    expect(out).toMatchObject({ settling: 1, toWrite: 0, repaired: 0 });
    expect(mirror).not.toHaveBeenCalled();
    expect(SETTLE_MS).toBeGreaterThanOrEqual(2 * 60 * 1000);
  });

  it("an unreadable day is unknown, never absent — its PG row is not deleted", async () => {
    const { deps, mirrorDelete } = world({ "u1|2026-09-21": "unreadable" }, { "u1|2026-09-21": day("approved") });
    const out = await repairHoursMirror(sqlStub(), { apply: true, deps, now: NOW });
    expect(out).toMatchObject({ unreadable: 1, toDelete: 0, deleted: 0 });
    expect(mirrorDelete).not.toHaveBeenCalled();
  });

  it("soft-deletes a day removed from Blob, but refuses a mass delete (the listing is suspect)", async () => {
    const one = world({}, { "u1|2026-09-21": day("approved") });
    expect(await repairHoursMirror(sqlStub(), { apply: true, deps: one.deps, now: NOW })).toMatchObject({ deleted: 1, deleteBreaker: false });
    const pg: Record<string, Entry> = {};
    for (let i = 0; i <= MAX_DELETES; i++) pg[`u${i}|2026-09-2${i % 9}`] = day("approved");
    const many = world({}, pg);
    const out = await repairHoursMirror(sqlStub(), { apply: true, deps: many.deps, now: NOW });
    expect(out).toMatchObject({ deleteBreaker: true, toDelete: 0, deleted: 0 });
    expect(many.mirrorDelete).not.toHaveBeenCalled();
  });

  it("reports a failed re-mirror instead of hiding it", async () => {
    const { deps } = world({ "u1|2026-09-21": { e: day("approved") } }, { "u1|2026-09-21": day("submitted") });
    deps.mirror = vi.fn(async (_userId: string, _entry: Entry): Promise<Record<string, unknown>> => ({ mirrored: false, reason: "error", error: "timed out" }));
    const out = await repairHoursMirror(sqlStub(), { apply: true, deps, now: NOW });
    expect(out).toMatchObject({ repaired: 0, failedCount: 1 });
    expect(out.failed[0]).toMatchObject({ key: "u1|2026-09-21", reason: "timed out" });
  });
});

describe("GET /api/internal/mirror-hours", () => {
  function res() {
    return {
      statusCode: 200,
      body: null as unknown,
      status(c: number) { this.statusCode = c; return this; },
      json(b: unknown) { this.body = b; return this; },
      setHeader() { return this; },
      end() { return this; },
    };
  }
  const base = (over: Record<string, unknown> = {}) => ({
    env: { CRON_SECRET: "s", SUPABASE_DB_URL: "postgres://x" },
    cronState: () => "ok",
    flagOn: async () => true,
    db: () => ({}),
    run: vi.fn(async (_sql: unknown, { apply }: { apply: boolean }) => ({ apply, repaired: 0, deleted: 0, failedCount: 0, deleteBreaker: false, failed: [] })),
    ...over,
  });

  it("is machine-only: no secret → 503, a wrong one → 401", async () => {
    const r1 = res();
    await handleMirrorHours({ method: "GET", headers: {} }, r1, base({ env: { SUPABASE_DB_URL: "x" } }));
    expect(r1.statusCode).toBe(503);
    const r2 = res();
    await handleMirrorHours({ method: "GET", headers: {} }, r2, base({ cronState: () => "denied" }));
    expect(r2.statusCode).toBe(401);
  });

  it("skips cleanly without Supabase or with the mirror off", async () => {
    const d1 = base({ env: { CRON_SECRET: "s" } });
    const r1 = res();
    await handleMirrorHours({ method: "GET", headers: {} }, r1, d1);
    expect(r1.body).toMatchObject({ skipped: "no supabase env" });
    expect(d1.run).not.toHaveBeenCalled();
    const d2 = base({ flagOn: async (k: string) => k !== "supabase_dual_write" });
    const r2 = res();
    await handleMirrorHours({ method: "GET", headers: {} }, r2, d2);
    expect(r2.body).toMatchObject({ skipped: "dual-write off" });
  });

  it("applies with the kill-switch on; dry-runs with it off", async () => {
    const on = base();
    await handleMirrorHours({ method: "GET", headers: {} }, res(), on);
    expect(on.run.mock.calls[0]![1]).toEqual({ apply: true });
    const off = base({ flagOn: async (k: string) => k !== "supabase_repair_hours" });
    await handleMirrorHours({ method: "GET", headers: {} }, res(), off);
    expect(off.run.mock.calls[0]![1]).toEqual({ apply: false });
  });

  it("a failed repair or a tripped delete breaker turns the cron run red (500)", async () => {
    const r = res();
    await handleMirrorHours({ method: "GET", headers: {} }, r, base({ run: async () => ({ failedCount: 1, failed: [{ key: "k" }] }) }));
    expect(r.statusCode).toBe(500);
    const r2 = res();
    await handleMirrorHours({ method: "GET", headers: {} }, r2, base({ run: async () => ({ deleteBreaker: true, failed: [] }) }));
    expect(r2.statusCode).toBe(500);
  });
});
