import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

/**
 * Jobs-mirror reconcile sweep — self-healing for the one-shot write-through
 * mirror. The seam it closes (proven in prod): a transient PG failure at job
 * create time leaves the job permanently absent from public.jobs, which
 * quarantines every hours allocation logged against it. The sweep re-mirrors
 * anything in Blob jobs.json that public.jobs lacks, via the SAME
 * mirrorJobToPg the write path uses.
 */
const requireFromHere = createRequire(import.meta.url);
const { reconcileJobsMirror } = requireFromHere(
  requireFromHere.resolve("../../../api/_lib/jobs-reconcile.js"),
) as {
  reconcileJobsMirror: (deps?: Record<string, unknown>) => Promise<{
    ran: boolean;
    reason?: string;
    error?: string;
    checked?: number;
    missing?: number;
    remirrored?: number;
    failed?: number;
    failures?: Array<{ jobId: string; reason?: string; error?: string }>;
  }>;
};

const ENV = { SUPABASE_DB_URL: "postgres://x" };

function sqlReturning(rows: Array<{ legacy_id: string }>) {
  // getDb() returns a tagged-template `sql` function.
  return () => async () => rows;
}

describe("reconcileJobsMirror — gating", () => {
  it("skips cleanly with no SUPABASE_DB_URL, before any flag/blob read", async () => {
    const isFlagOn = vi.fn();
    const readBlob = vi.fn();
    const out = await reconcileJobsMirror({ env: {}, isFlagOn, readBlob });
    expect(out).toEqual({ ran: false, reason: "no supabase env" });
    expect(isFlagOn).not.toHaveBeenCalled();
    expect(readBlob).not.toHaveBeenCalled();
  });

  it("skips cleanly when supabase_dual_write_jobs is off", async () => {
    const readBlob = vi.fn();
    const out = await reconcileJobsMirror({
      env: ENV,
      isFlagOn: async () => false,
      readBlob,
    });
    expect(out).toEqual({ ran: false, reason: "flag off" });
    expect(readBlob).not.toHaveBeenCalled();
  });
});

describe("reconcileJobsMirror — sweep", () => {
  it("re-mirrors exactly the jobs missing from PG and reports counts", async () => {
    const mirror = vi.fn<(id: string) => Promise<{ mirrored: boolean }>>(async () => ({ mirrored: true }));
    const recordDrift = vi.fn(async () => {});
    const out = await reconcileJobsMirror({
      env: ENV,
      isFlagOn: async (k: string) => k === "supabase_dual_write_jobs",
      readBlob: async () => ({ jobs: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
      getDb: sqlReturning([{ legacy_id: "a" }]),
      mirrorJobToPg: mirror,
      recordDrift,
    });
    expect(out).toMatchObject({ ran: true, checked: 3, missing: 2, remirrored: 2, failed: 0 });
    expect(mirror.mock.calls.map((c) => c[0])).toEqual(["b", "c"]);
    expect(recordDrift).not.toHaveBeenCalled();
  });

  it("no missing jobs → clean zero-work summary, mirror never called", async () => {
    const mirror = vi.fn();
    const out = await reconcileJobsMirror({
      env: ENV,
      isFlagOn: async () => true,
      readBlob: async () => ({ jobs: [{ id: "a" }] }),
      getDb: sqlReturning([{ legacy_id: "a" }]),
      mirrorJobToPg: mirror,
    });
    expect(out).toMatchObject({ ran: true, checked: 1, missing: 0, remirrored: 0, failed: 0 });
    expect(mirror).not.toHaveBeenCalled();
  });

  it("empty jobs.json → runs with zero counts, no PG query needed", async () => {
    const getDb = vi.fn();
    const out = await reconcileJobsMirror({
      env: ENV,
      isFlagOn: async () => true,
      readBlob: async () => ({ jobs: [] }),
      getDb,
    });
    expect(out).toMatchObject({ ran: true, checked: 0, missing: 0, remirrored: 0, failed: 0 });
    expect(getDb).not.toHaveBeenCalled();
  });

  it("a failed re-mirror is counted, listed, recorded as drift, and does NOT stop the sweep", async () => {
    const mirror = vi.fn(async (id: string) =>
      id === "b" ? { mirrored: false, reason: "error", error: "pooler down" } : { mirrored: true },
    );
    const recordDrift = vi.fn(async () => {});
    const out = await reconcileJobsMirror({
      env: ENV,
      isFlagOn: async () => true,
      readBlob: async () => ({ jobs: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
      getDb: sqlReturning([]),
      mirrorJobToPg: mirror,
      recordDrift,
    });
    expect(out).toMatchObject({ ran: true, checked: 3, missing: 3, remirrored: 2, failed: 1 });
    expect(out.failures).toEqual([{ jobId: "b", reason: "error", error: "pooler down" }]);
    expect(recordDrift).toHaveBeenCalledTimes(1);
    expect(recordDrift).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "jobs", jobId: "b", key: "jobs.json" }),
    );
  });

  it("never throws — a PG query blow-up returns ran:false error", async () => {
    const out = await reconcileJobsMirror({
      env: ENV,
      isFlagOn: async () => true,
      readBlob: async () => ({ jobs: [{ id: "a" }] }),
      getDb: () => async () => {
        throw new Error("connection refused");
      },
    });
    expect(out).toEqual({ ran: false, reason: "error", error: "connection refused" });
  });

  it("rows without ids are ignored, never mirrored", async () => {
    const mirror = vi.fn<(id: string) => Promise<{ mirrored: boolean }>>(async () => ({ mirrored: true }));
    const out = await reconcileJobsMirror({
      env: ENV,
      isFlagOn: async () => true,
      readBlob: async () => ({ jobs: [{ id: "a" }, {}, null, { id: "" }] }),
      getDb: sqlReturning([]),
      mirrorJobToPg: mirror,
    });
    expect(out).toMatchObject({ ran: true, checked: 1, missing: 1, remirrored: 1 });
    expect(mirror.mock.calls.map((c) => c[0])).toEqual(["a"]);
  });
});
