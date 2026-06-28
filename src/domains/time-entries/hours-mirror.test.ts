import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Hours dual-write mirror (#152) — the SAFETY-critical behaviours: it is
 * triple-gated (no SUPABASE env → skip before any flag/blob read; flag off →
 * skip; guard) and BEST-EFFORT (any error swallowed, never throws, so a mirror
 * failure can never break a worker's hours save). The happy upsert path is
 * proven on a live preview, not here.
 */

const requireFromHere = createRequire(import.meta.url);
const mirrorPath = requireFromHere.resolve("../../../api/_lib/hours-mirror.js");
const { mirrorTimeEntry, mirrorTimeEntryDelete, malformedReason, withTimeout } = requireFromHere(mirrorPath) as {
  mirrorTimeEntry: (userId: string, entry: unknown, deps?: object) => Promise<{ mirrored: boolean; reason?: string; source?: boolean }>;
  mirrorTimeEntryDelete: (userId: string, date: string, deps?: object) => Promise<{ mirrored: boolean; reason?: string; source?: boolean }>;
  malformedReason: (row: Record<string, unknown>) => string;
  withTimeout: <T>(promise: Promise<T>, ms: number, label: string) => Promise<T>;
};

const ENTRY = { id: "e1", date: "2026-06-01", totalHours: 8, ordinaryHours: 8, overtimeHours: 0, status: "approved" };
const OLD_URL = process.env.SUPABASE_DB_URL;
function setEnv(on: boolean) {
  if (on) process.env.SUPABASE_DB_URL = "postgres://fake";
  else delete process.env.SUPABASE_DB_URL;
}
const throwDb = () => { throw new Error("getDb must not be called"); };
const throwFlag = async () => { throw new Error("isFlagOn must not be called"); };
// A getDb whose sql tag resolves every query to [] — so resolveTenantAndUser finds
// no tenant and the write returns early ("tenant/user not mirrored") WITHOUT faking
// the full upsert. Enough to prove the gate let the write run and `source` threaded.
const emptyDb = () => () => Promise.resolve([] as unknown[]);

afterEach(() => {
  if (OLD_URL === undefined) delete process.env.SUPABASE_DB_URL;
  else process.env.SUPABASE_DB_URL = OLD_URL;
});

describe("mirrorTimeEntry — gating + best-effort", () => {
  it("skips with no entry/date", async () => {
    setEnv(true);
    expect(await mirrorTimeEntry("u1", null, { getDb: throwDb, isFlagOn: throwFlag })).toEqual({
      mirrored: false,
      reason: "no entry/date",
    });
  });

  it("short-circuits when SUPABASE env is absent (no flag/blob read, no db)", async () => {
    setEnv(false);
    const res = await mirrorTimeEntry("u1", ENTRY, { getDb: throwDb, isFlagOn: throwFlag });
    expect(res).toEqual({ mirrored: false, reason: "no supabase env" });
  });

  it("does nothing when the flag is off (no db touch)", async () => {
    setEnv(true);
    const res = await mirrorTimeEntry("u1", ENTRY, { getDb: throwDb, isFlagOn: async () => false });
    expect(res).toEqual({ mirrored: false, reason: "flag off" });
  });

  it("swallows any error — never throws (Blob stays authoritative)", async () => {
    setEnv(true);
    const res = await mirrorTimeEntry("u1", ENTRY, { isFlagOn: async () => true, getDb: () => { throw new Error("boom"); } });
    expect(res.mirrored).toBe(false);
    expect(res.reason).toBe("error");
  });

  it("swallows a timeout when the inner DB work hangs (never delays the save past the bound)", async () => {
    setEnv(true);
    // getDb returns an sql tag whose first query never resolves → the race times out.
    const getDb = () => () => new Promise(() => {});
    const res = await mirrorTimeEntry("u1", ENTRY, { isFlagOn: async () => true, getDb, timeoutMs: 20 });
    expect(res.mirrored).toBe(false);
    expect(res.reason).toBe("error");
  });
});

describe("PG-as-source Stage A — supabase_source_hours gating", () => {
  it("source flag alone activates the write and reports source:true", async () => {
    setEnv(true);
    const res = await mirrorTimeEntry("u1", ENTRY, {
      isFlagOn: async (k: string) => k === "supabase_source_hours",
      getDb: emptyDb,
    });
    // Reached the write (getDb called) → tenant lookup empty → early return, source threaded.
    expect(res).toEqual({ mirrored: false, reason: "tenant/user not mirrored", source: true });
  });

  it("dual_write alone still activates the write (back-compat), source:false", async () => {
    setEnv(true);
    const res = await mirrorTimeEntry("u1", ENTRY, {
      isFlagOn: async (k: string) => k === "supabase_dual_write",
      getDb: emptyDb,
    });
    expect(res).toEqual({ mirrored: false, reason: "tenant/user not mirrored", source: false });
  });

  it("reads the source flag FIRST and short-circuits (no dual_write read) when source is on", async () => {
    setEnv(true);
    const keys: string[] = [];
    const res = await mirrorTimeEntry("u1", ENTRY, {
      isFlagOn: async (k: string) => { keys.push(k); return k === "supabase_source_hours"; },
      getDb: emptyDb,
    });
    expect(keys).toEqual(["supabase_source_hours"]); // dual_write never read on the promoted hot path
    expect(res.source).toBe(true);
  });

  it("delete: source flag activates the delete-mirror and reports source:true", async () => {
    setEnv(true);
    const res = await mirrorTimeEntryDelete("u1", "2026-06-01", {
      isFlagOn: async (k: string) => k === "supabase_source_hours",
      getDb: emptyDb,
    });
    expect(res).toEqual({ mirrored: false, reason: "tenant/user not mirrored", source: true });
  });
});

describe("withTimeout — bounds the mirror's PG work so it can't delay an hours save", () => {
  it("rejects when the work exceeds the timeout", async () => {
    await expect(withTimeout(new Promise(() => {}), 20, "mirror")).rejects.toThrow(/timed out/);
  });
  it("resolves with the value when the work finishes in time", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000, "mirror")).resolves.toBe("ok");
  });
});

describe("malformedReason — never hand the upsert a row that trips a schema CHECK", () => {
  const ok = { total_hours: 8, ordinary_hours: 8, overtime_hours: 0, notes: null, status: "approved" };
  it("passes a clean row", () => expect(malformedReason(ok)).toBe(""));
  it("catches an out-of-range total", () => expect(malformedReason({ ...ok, total_hours: 20, ordinary_hours: 20 })).toBe("invalid total"));
  it("catches an ordinary+overtime mismatch", () => expect(malformedReason({ ...ok, ordinary_hours: 5, overtime_hours: 1 })).toBe("ordinary+overtime != total"));
  it("catches over-length notes (>500)", () => expect(malformedReason({ ...ok, notes: "x".repeat(501) })).toBe("notes too long"));
  it("catches an unknown status", () => expect(malformedReason({ ...ok, status: "weird" })).toBe("invalid status"));
});

describe("mirrorTimeEntryDelete — gating + best-effort", () => {
  it("short-circuits with no env, skips on flag off, swallows errors", async () => {
    setEnv(false);
    expect((await mirrorTimeEntryDelete("u1", "2026-06-01", { getDb: throwDb, isFlagOn: throwFlag })).reason).toBe("no supabase env");
    setEnv(true);
    expect((await mirrorTimeEntryDelete("u1", "2026-06-01", { getDb: throwDb, isFlagOn: async () => false })).reason).toBe("flag off");
    expect((await mirrorTimeEntryDelete("u1", "2026-06-01", { isFlagOn: async () => true, getDb: () => { throw new Error("boom"); } })).reason).toBe("error");
  });
});
