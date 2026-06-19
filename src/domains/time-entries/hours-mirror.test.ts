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
const { mirrorTimeEntry, mirrorTimeEntryDelete } = requireFromHere(mirrorPath) as {
  mirrorTimeEntry: (userId: string, entry: unknown, deps?: object) => Promise<{ mirrored: boolean; reason?: string }>;
  mirrorTimeEntryDelete: (userId: string, date: string, deps?: object) => Promise<{ mirrored: boolean; reason?: string }>;
};

const ENTRY = { id: "e1", date: "2026-06-01", totalHours: 8, ordinaryHours: 8, overtimeHours: 0, status: "approved" };
const OLD_URL = process.env.SUPABASE_DB_URL;
function setEnv(on: boolean) {
  if (on) process.env.SUPABASE_DB_URL = "postgres://fake";
  else delete process.env.SUPABASE_DB_URL;
}
const throwDb = () => { throw new Error("getDb must not be called"); };
const throwFlag = async () => { throw new Error("isFlagOn must not be called"); };

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
