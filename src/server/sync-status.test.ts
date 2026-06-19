import { afterEach, describe, expect, it } from "vitest";
import { loadHoursSyncStatus, summariseHoursSync, type HoursSyncCheck } from "./sync-status";

const OLD_URL = process.env.SUPABASE_DB_URL;
afterEach(() => {
  if (OLD_URL === undefined) delete process.env.SUPABASE_DB_URL;
  else process.env.SUPABASE_DB_URL = OLD_URL;
});

function passCheck(over: Partial<HoursSyncCheck> = {}): HoursSyncCheck {
  return {
    status: "pass",
    checked_at: "2026-06-20T03:00:00.000Z",
    blob_count: 9,
    pg_count: 9,
    blob_total: 70.8,
    pg_total: 70.8,
    matched: 9,
    only_in_blob: 0,
    only_in_pg: 0,
    mismatched: 0,
    allocations_checked: true,
    hash_match: true,
    details: { hashMatch: true, onlyInBlob: [], onlyInPg: [], mismatched: [] },
    duration_ms: 4264,
    ...over,
  };
}

describe("loadHoursSyncStatus", () => {
  it("is honestly 'not wired' when SUPABASE_DB_URL is absent (no DB touch)", async () => {
    delete process.env.SUPABASE_DB_URL;
    expect(await loadHoursSyncStatus()).toEqual({ wired: false, check: null });
  });
});

describe("summariseHoursSync", () => {
  it("not_wired → not_wired", () => {
    expect(summariseHoursSync({ wired: false, check: null })).toEqual({ state: "not_wired" });
  });

  it("wired-but-query-failed → error (not 'not_wired')", () => {
    expect(summariseHoursSync({ wired: false, check: null, error: "boom" })).toEqual({ state: "error", error: "boom" });
  });

  it("wired but no recorded check → none", () => {
    expect(summariseHoursSync({ wired: true, check: null })).toEqual({ state: "none" });
  });

  it("a pass check → IN SYNC summary with counts/totals", () => {
    const s = summariseHoursSync({ wired: true, check: passCheck() });
    expect(s).toMatchObject({
      state: "pass",
      blobCount: 9,
      pgCount: 9,
      blobTotal: 70.8,
      pgTotal: 70.8,
      allocationsChecked: true,
      hashMatch: true,
      checkedAt: "2026-06-20T03:00:00.000Z",
    });
  });

  it("a fail check → drift summary with the breakdown + details", () => {
    const s = summariseHoursSync({
      wired: true,
      check: passCheck({
        status: "fail",
        only_in_blob: 1,
        only_in_pg: 0,
        mismatched: 2,
        hash_match: false,
        details: { onlyInBlob: ["u1|2026-06-02"], mismatched: [{ key: "u1|2026-06-01", diffs: {} }] },
      }),
    });
    expect(s.state).toBe("fail");
    if (s.state === "fail") {
      expect(s.onlyInBlob).toBe(1);
      expect(s.mismatched).toBe(2);
      expect(s.hashMatch).toBe(false);
      expect(s.details).toHaveProperty("onlyInBlob");
    }
  });
});
