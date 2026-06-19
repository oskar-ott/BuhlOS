import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Hours read-cutover (#152). blobEntryFromPgRow reconstructs the exact Blob
 * entry shape from a joined Postgres row (reversing uuid→legacy, numeric→number,
 * timestamptz→ISO). listUserEntriesFromPgIfEnabled is triple-gated + best-effort
 * (disabled/error → {pg:false} → caller falls back to Blob). The live read is
 * proven by a Blob-vs-PG diff on dev, not here.
 */

const requireFromHere = createRequire(import.meta.url);
const p = requireFromHere.resolve("../../../api/_lib/hours-read.js");
const { blobEntryFromPgRow, listUserEntriesFromPgIfEnabled } = requireFromHere(p) as {
  blobEntryFromPgRow: (r: Record<string, unknown>) => Record<string, unknown>;
  listUserEntriesFromPgIfEnabled: (
    userId: string,
    opts?: object,
    deps?: object
  ) => Promise<{ pg: boolean; reason?: string; entries?: unknown[] }>;
};

const OLD_URL = process.env.SUPABASE_DB_URL;
afterEach(() => {
  if (OLD_URL === undefined) delete process.env.SUPABASE_DB_URL;
  else process.env.SUPABASE_DB_URL = OLD_URL;
});
const throwDb = () => { throw new Error("getDb must not be called"); };

describe("blobEntryFromPgRow", () => {
  it("reconstructs the exact Blob entry shape from a joined PG row", () => {
    const row = {
      legacy_id: "e1",
      work_date: "2026-06-01",
      start_time: "07:00",
      end_time: "15:06",
      break_minutes: 30,
      total_hours: "7.60",
      ordinary_hours: "7.60",
      overtime_hours: "0.00",
      ot_overridden: false,
      notes: null,
      status: "approved",
      submitted_at: new Date("2026-06-01T08:00:00.000Z"),
      approved_at: new Date("2026-06-02T09:00:00.000Z"),
      rejected_reason: null,
      source: "self",
      created_at: new Date("2026-06-01T10:00:00.000Z"),
      updated_at: new Date("2026-06-03T11:00:00.000Z"),
      user_legacy_id: "u1",
      user_name: "Dev",
      user_role: "admin",
      approved_by_legacy: "u_admin",
      created_by_legacy: "u1",
      created_by_name: "Dev",
      allocations: [{ jobId: null, hours: "7.60", notes: null, sortOrder: 0 }],
    };
    expect(blobEntryFromPgRow(row)).toEqual({
      id: "e1",
      userId: "u1",
      userName: "Dev",
      userRole: "admin",
      date: "2026-06-01",
      startTime: "07:00",
      endTime: "15:06",
      breakMinutes: 30,
      totalHours: 7.6,
      ordinaryHours: 7.6,
      overtimeHours: 0,
      otOverridden: false,
      notes: null,
      status: "approved",
      submittedAt: "2026-06-01T08:00:00.000Z",
      approvedBy: "u_admin",
      approvedAt: "2026-06-02T09:00:00.000Z",
      rejectedReason: null,
      allocations: [{ jobId: null, hours: 7.6, notes: null, sortOrder: 0 }],
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-03T11:00:00.000Z",
      enteredByUserId: "u1",
      enteredByName: "Dev",
      source: "self",
    });
  });

  it("adds rejectedAt/rejectedBy ONLY for a rejected entry (matches Blob key presence)", () => {
    const base = {
      legacy_id: "e9", work_date: "2026-06-05", start_time: "07:00", end_time: "15:00", break_minutes: 30,
      total_hours: "8.00", ordinary_hours: "8.00", overtime_hours: "0.00", ot_overridden: false,
      notes: null, status: "approved", submitted_at: null, approved_at: null, rejected_reason: null,
      source: "self", created_at: new Date("2026-06-05T10:00:00.000Z"), updated_at: null,
      user_legacy_id: "u1", user_name: "Dev", user_role: "admin",
      approved_by_legacy: null, rejected_by_legacy: null, created_by_legacy: null, created_by_name: null,
      allocations: [],
    };
    // not rejected → no rejectedAt/rejectedBy keys at all
    const ok = blobEntryFromPgRow({ ...base, rejected_at: null });
    expect("rejectedAt" in ok).toBe(false);
    expect("rejectedBy" in ok).toBe(false);
    // rejected → both present
    const rej = blobEntryFromPgRow({
      ...base, status: "rejected", rejected_reason: "fix start time",
      rejected_at: new Date("2026-06-06T09:00:00.000Z"), rejected_by_legacy: "u_admin",
    });
    expect(rej.rejectedAt).toBe("2026-06-06T09:00:00.000Z");
    expect(rej.rejectedBy).toBe("u_admin");
  });

  it("handles null timestamps, unresolved attribution, and a job-scoped allocation", () => {
    const row = {
      legacy_id: "e2", work_date: "2026-06-02", start_time: null, end_time: null, break_minutes: null,
      total_hours: "8.00", ordinary_hours: "8.00", overtime_hours: "0.00", ot_overridden: true,
      notes: "x", status: "submitted", submitted_at: new Date("2026-06-02T08:00:00.000Z"),
      approved_at: null, rejected_reason: null, source: null,
      created_at: new Date("2026-06-02T07:00:00.000Z"), updated_at: null,
      user_legacy_id: "u2", user_name: "Bob", user_role: "tradie",
      approved_by_legacy: null, created_by_legacy: null, created_by_name: null,
      allocations: [{ jobId: "job-7", hours: "8.00", notes: "wiring", sortOrder: 0 }],
    };
    const e = blobEntryFromPgRow(row);
    expect(e.approvedBy).toBeNull();
    expect(e.approvedAt).toBeNull();
    expect(e.updatedAt).toBeNull();
    expect(e.enteredByUserId).toBeNull();
    expect(e.allocations).toEqual([{ jobId: "job-7", hours: 8, notes: "wiring", sortOrder: 0 }]);
  });
});

describe("listUserEntriesFromPgIfEnabled — gated + best-effort", () => {
  it("falls back (pg:false) when SUPABASE env is absent — no flag/db touch", async () => {
    delete process.env.SUPABASE_DB_URL;
    const r = await listUserEntriesFromPgIfEnabled("u1", {}, { getDb: throwDb, isFlagOn: async () => { throw new Error("nope"); } });
    expect(r).toEqual({ pg: false, reason: "no supabase env" });
  });

  it("falls back (pg:false) when the flag is off — no db touch", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await listUserEntriesFromPgIfEnabled("u1", {}, { getDb: throwDb, isFlagOn: async () => false });
    expect(r).toEqual({ pg: false, reason: "flag off" });
  });

  it("falls back (pg:false) on any error — never throws", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await listUserEntriesFromPgIfEnabled("u1", {}, { isFlagOn: async () => true, getDb: () => { throw new Error("boom"); } });
    expect(r.pg).toBe(false);
    expect(r.reason).toBe("error");
  });
});
