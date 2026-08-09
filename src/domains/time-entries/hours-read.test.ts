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
const { blobEntryFromPgRow, unfaithfulReason, listUserEntriesFromPgIfEnabled } = requireFromHere(p) as {
  blobEntryFromPgRow: (r: Record<string, unknown>) => Record<string, unknown>;
  unfaithfulReason: (e: Record<string, unknown>) => string;
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

/**
 * The faithfulness gate. A partial mirror (entry upserted, allocations
 * quarantined because their job was never mirrored into public.jobs) put a
 * zero-allocation entry in PG. Served, it failed the Phil client's
 * TimeEntrySchema (allocations.min(1)) — which discards the WHOLE list — so a
 * worker's logged week read as blank while Blob held the hours all along. The
 * gate must fall the whole call back to Blob instead of serving that row.
 */
describe("unfaithfulReason — reject a reconstruction a Blob write could never produce", () => {
  const faithful = { id: "e1", date: "2026-07-16", totalHours: 7.6, allocations: [{ jobId: "dca-alexandria", hours: 7.6 }] };

  it("passes a faithful entry", () => expect(unfaithfulReason(faithful)).toBe(""));

  it("passes a multi-job split that sums to the total", () => {
    expect(unfaithfulReason({ ...faithful, allocations: [{ jobId: "a", hours: 4 }, { jobId: "b", hours: 3.6 }] })).toBe("");
  });

  it("passes an Internal (null jobId) allocation — a legitimate Blob shape", () => {
    expect(unfaithfulReason({ ...faithful, allocations: [{ jobId: null, hours: 7.6 }] })).toBe("");
  });

  it("catches the prod failure: entry present, allocations stripped", () => {
    expect(unfaithfulReason({ ...faithful, allocations: [] })).toBe("no allocations");
  });

  it("catches a missing/!array allocations field", () => {
    expect(unfaithfulReason({ ...faithful, allocations: undefined })).toBe("no allocations");
  });

  it("catches a partially-reconciled split that no longer sums to the total", () => {
    expect(unfaithfulReason({ ...faithful, allocations: [{ jobId: "a", hours: 4 }] })).toMatch(/sum 4 != totalHours 7.6/);
  });

  it("tolerates float dust within the writer's own tolerance (never rejects a sum alloc-pg would accept)", () => {
    expect(unfaithfulReason({ ...faithful, allocations: [{ jobId: "a", hours: 2.53 }, { jobId: "b", hours: 5.07 }] })).toBe("");
  });
});

describe("listUserEntriesFromPgIfEnabled — faithfulness gate", () => {
  // The exact prod row (Oskar, 2026-07-16, 7.6h against dca-alexandria — a job
  // absent from public.jobs, so the mirror quarantined the allocation).
  const PG_ROW = {
    legacy_id: "mrn3gknqq429f0", work_date: "2026-07-16",
    start_time: null, end_time: null, break_minutes: 30,
    total_hours: "7.60", ordinary_hours: "7.60", overtime_hours: "0.00", ot_overridden: false,
    notes: null, status: "approved", submitted_at: null, approved_at: null,
    rejected_at: null, rejected_reason: null, source: "self",
    created_at: new Date("2026-07-16T05:54:27.350Z"), updated_at: new Date("2026-07-16T06:15:04.950Z"),
    user_legacy_id: "u_mnxp66x9jl6h", user_name: "Oskar", user_role: "tradie",
    approved_by_legacy: null, rejected_by_legacy: null, created_by_legacy: null, created_by_name: null,
    allocations: [] as unknown[],
  };
  // sql tag answering the tenant lookup, the mapped-user guard (2026-08-09),
  // then the entries query.
  const dbServing = (rows: unknown[], { mapped = true }: { mapped?: boolean } = {}) => () => {
    let call = 0;
    return () => {
      call += 1;
      if (call === 1) return Promise.resolve([{ id: "t1" }]);
      if (call === 2) return Promise.resolve(mapped ? [{ id: "p1" }] : []);
      return Promise.resolve(rows);
    };
  };

  it("does NOT serve an entry whose allocations were stripped — falls back to Blob", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await listUserEntriesFromPgIfEnabled(
      "u_mnxp66x9jl6h", {}, { isFlagOn: async () => true, getDb: dbServing([PG_ROW]) }
    );
    expect(r).toEqual({ pg: false, reason: "unfaithful reconstruction" });
  });

  it("one bad entry fails the WHOLE call to Blob — never silently drops just that day", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const good = { ...PG_ROW, legacy_id: "ok1", work_date: "2026-07-10", allocations: [{ jobId: "birdwood-iv3232", hours: "7.60", notes: null, sortOrder: 0 }] };
    const r = await listUserEntriesFromPgIfEnabled(
      "u_mnxp66x9jl6h", {}, { isFlagOn: async () => true, getDb: dbServing([PG_ROW, good]) }
    );
    expect(r.pg).toBe(false);
    expect(r.entries).toBeUndefined();
  });

  it("serves PG (pg:true) once the allocation is present — the gate is not a blanket disable", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const row = { ...PG_ROW, allocations: [{ jobId: "dca-alexandria", hours: "7.60", notes: null, sortOrder: 0 }] };
    const r = await listUserEntriesFromPgIfEnabled(
      "u_mnxp66x9jl6h", {}, { isFlagOn: async () => true, getDb: dbServing([row]) }
    );
    expect(r.pg).toBe(true);
    expect(r.entries).toHaveLength(1);
    expect((r.entries as Array<{ allocations: unknown }>)[0]!.allocations).toEqual([
      { jobId: "dca-alexandria", hours: 7.6, notes: null, sortOrder: 0 },
    ]);
  });

  it("trusts a genuinely empty PG result ONLY for a mapped worker", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await listUserEntriesFromPgIfEnabled("u1", {}, { isFlagOn: async () => true, getDb: dbServing([]) });
    expect(r).toEqual({ pg: true, entries: [] });
  });
});

/**
 * The completeness guard (2026-08-09 prod incident). user_profiles held only
 * the June import; every crew-link signup was absent, their entries were never
 * mirrored, and this rung trusted the resulting empty list — serving those
 * workers a blank week while Blob held the days. An unknown worker must fall
 * back to Blob, never be served PG-empty as truth.
 */
describe("listUserEntriesFromPgIfEnabled — unmapped-worker guard", () => {
  const dbUnmapped = (rows: unknown[]) => () => {
    let call = 0;
    return () => {
      call += 1;
      if (call === 1) return Promise.resolve([{ id: "t1" }]);
      if (call === 2) return Promise.resolve([]); // no user_profiles row
      return Promise.resolve(rows);
    };
  };

  it("a worker PG doesn't know falls back to Blob — even though PG would answer empty", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await listUserEntriesFromPgIfEnabled(
      "u_crewlink_signup", {}, { isFlagOn: async () => true, getDb: dbUnmapped([]) }
    );
    expect(r).toEqual({ pg: false, reason: "unmapped user" });
  });

  it("a worker PG doesn't know falls back even when stray rows exist for them", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await listUserEntriesFromPgIfEnabled(
      "u_crewlink_signup", {}, { isFlagOn: async () => true, getDb: dbUnmapped([{ legacy_id: "e1" }]) }
    );
    expect(r).toEqual({ pg: false, reason: "unmapped user" });
  });
});
