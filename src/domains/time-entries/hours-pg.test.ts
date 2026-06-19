import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Shared hours→Postgres mapper (api/_lib/hours-pg) — the single source of truth
 * the importer and the live dual-write mirror both use. Covers the field mapping
 * + 2dp rounding + defaults directly (the importer exercises it via
 * buildTimeEntryRows; the mirror via mirrorTimeEntry).
 */

const requireFromHere = createRequire(import.meta.url);
const p = requireFromHere.resolve("../../../api/_lib/hours-pg.js");
const { timeEntryRowFromBlob, TIME_ENTRY_INSERT_COLS, TIME_ENTRY_MUTABLE_COLS } = requireFromHere(p) as {
  timeEntryRowFromBlob: (
    entry: unknown,
    ctx: { userUuid: string; date: string; nowIso: string; resolveUser?: (id: string) => string | null }
  ) => Record<string, unknown>;
  TIME_ENTRY_INSERT_COLS: string[];
  TIME_ENTRY_MUTABLE_COLS: string[];
};

describe("timeEntryRowFromBlob", () => {
  it("maps a blob entry to a row (2dp rounding, time/null coercion)", () => {
    const row = timeEntryRowFromBlob(
      { id: "e1", totalHours: 7.599, ordinaryHours: 7.599, overtimeHours: 0, status: "approved", startTime: "07:00", endTime: "bad", breakMinutes: 30, source: "phil", createdAt: "2026-06-01T10:00:00.000Z" },
      { userUuid: "uu1", date: "2026-06-01", nowIso: "2026-06-19T00:00:00.000Z" }
    );
    expect(row).toEqual({
      user_id: "uu1",
      legacy_id: "e1",
      work_date: "2026-06-01",
      start_time: "07:00",
      end_time: null,
      break_minutes: 30,
      total_hours: 7.6,
      ordinary_hours: 7.6,
      overtime_hours: 0,
      ot_overridden: false,
      notes: null,
      status: "approved",
      submitted_at: null,
      approved_at: null,
      approved_by: null,
      rejected_at: null,
      rejected_reason: null,
      created_by: null,
      source: "phil",
      created_at: "2026-06-01T10:00:00.000Z",
    });
  });

  it("resolves attribution (approvedBy→approved_by, enteredByUserId→created_by) via resolveUser", () => {
    const map = new Map([["u_admin", "uuid-admin"], ["u_office", "uuid-office"]]);
    const row = timeEntryRowFromBlob(
      { id: "e2", totalHours: 8, ordinaryHours: 8, overtimeHours: 0, status: "approved", approvedBy: "u_admin", enteredByUserId: "u_office" },
      { userUuid: "uu1", date: "2026-06-03", nowIso: "NOW", resolveUser: (id: string) => map.get(id) || null }
    );
    expect(row.approved_by).toBe("uuid-admin");
    expect(row.created_by).toBe("uuid-office");
    // an unresolved attribution id → null (entry still valid)
    const row2 = timeEntryRowFromBlob(
      { id: "e3", totalHours: 8, ordinaryHours: 8, overtimeHours: 0, status: "approved", approvedBy: "ghost" },
      { userUuid: "uu1", date: "2026-06-04", nowIso: "NOW", resolveUser: (id: string) => map.get(id) || null }
    );
    expect(row2.approved_by).toBeNull();
    expect(row2.created_by).toBeNull();
  });

  it("defaults status→draft, legacy_id→null, created_at→nowIso", () => {
    const row = timeEntryRowFromBlob(
      { totalHours: 8, ordinaryHours: 8, overtimeHours: 0 },
      { userUuid: "uu1", date: "2026-06-02", nowIso: "NOW" }
    );
    expect(row.status).toBe("draft");
    expect(row.legacy_id).toBeNull();
    expect(row.created_at).toBe("NOW");
  });

  it("INSERT cols = mapped row keys + tenant_id; mutable excludes key + created_at", () => {
    const row = timeEntryRowFromBlob({ totalHours: 8, ordinaryHours: 8, overtimeHours: 0 }, { userUuid: "uu1", date: "2026-06-02", nowIso: "NOW" });
    expect(new Set(TIME_ENTRY_INSERT_COLS)).toEqual(new Set(["tenant_id", ...Object.keys(row)]));
    for (const c of ["user_id", "work_date", "legacy_id", "created_at"]) expect(TIME_ENTRY_MUTABLE_COLS).not.toContain(c);
  });
});
