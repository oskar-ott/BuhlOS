import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Hours importer row builder (time_entries). Pure mapping + quarantine:
 * legacy-user→uuid resolution (missing → quarantine, never guessed), the
 * payroll-critical validators reused from the dry-run planner (date,
 * status, total in (0,16], ordinary+overtime==total), notes-length CHECK,
 * (user,date) dedup, created_at preservation, and insert/mutable column
 * lock-step.
 */

const requireFromHere = createRequire(import.meta.url);
const rowsPath = requireFromHere.resolve("../../../scripts/importers/lib/hours-rows.js");
const mod = requireFromHere(rowsPath) as {
  buildTimeEntryRows: (input: {
    records?: Array<{ userId: string; date: string; entry: unknown }>;
    userMap?: Map<string, string>;
    nowIso?: string;
  }) => {
    rows: Array<Record<string, unknown>>;
    quarantine: Array<{ ref: string; reason: string }>;
  };
  TIME_ENTRY_MUTABLE_COLS: string[];
  TIME_ENTRY_INSERT_COLS: string[];
};
const { buildTimeEntryRows, TIME_ENTRY_INSERT_COLS, TIME_ENTRY_MUTABLE_COLS } = mod;

const NOW = "2026-06-19T00:00:00.000Z";
const MAP = new Map([["u1", "uuid-1"]]);

function rec(entry: Record<string, unknown>, over: { userId?: string; date?: string } = {}) {
  return { userId: over.userId ?? "u1", date: over.date ?? "2026-06-01", entry };
}
function goodEntry(over: Record<string, unknown> = {}) {
  return { id: "e1", totalHours: 8, ordinaryHours: 8, overtimeHours: 0, status: "approved", ...over };
}

describe("buildTimeEntryRows", () => {
  it("maps a clean entry faithfully and resolves the user uuid", () => {
    const { rows, quarantine } = buildTimeEntryRows({
      records: [
        rec({ id: "e1", totalHours: 7.6, ordinaryHours: 7.6, overtimeHours: 0, status: "approved", startTime: "07:00", endTime: "15:06", breakMinutes: 30, source: "phil", createdAt: "2026-06-01T10:00:00.000Z" }),
      ],
      userMap: MAP,
      nowIso: NOW,
    });
    expect(quarantine).toHaveLength(0);
    expect(rows[0]).toEqual({
      user_id: "uuid-1",
      legacy_id: "e1",
      work_date: "2026-06-01",
      start_time: "07:00",
      end_time: "15:06",
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

  it("quarantines an entry whose user is not imported (never guesses a uuid)", () => {
    const { rows, quarantine } = buildTimeEntryRows({
      records: [rec(goodEntry(), { userId: "ghost" })],
      userMap: MAP,
      nowIso: NOW,
    });
    expect(rows).toHaveLength(0);
    expect(quarantine[0]!.reason).toMatch(/user not imported/);
  });

  it("quarantines bad date, bad total, ordinary+overtime mismatch, unknown status, long notes", () => {
    const { rows, quarantine } = buildTimeEntryRows({
      records: [
        rec(goodEntry(), { date: "2026-13-45" }),
        rec(goodEntry({ totalHours: 0 })),
        rec(goodEntry({ totalHours: 20 }), { date: "2026-06-02" }),
        rec(goodEntry({ totalHours: 8, ordinaryHours: 5, overtimeHours: 1 }), { date: "2026-06-03" }),
        rec(goodEntry({ status: "weird" }), { date: "2026-06-04" }),
        rec(goodEntry({ notes: "x".repeat(501) }), { date: "2026-06-05" }),
      ],
      userMap: MAP,
      nowIso: NOW,
    });
    expect(rows).toHaveLength(0);
    expect(quarantine).toHaveLength(6);
    expect(quarantine.map((q) => q.reason).join("|")).toMatch(/date.*total.*\(0.*!= total.*status.*notes/s);
  });

  it("quarantines a duplicate (user, date)", () => {
    const { rows, quarantine } = buildTimeEntryRows({
      records: [rec(goodEntry({ id: "a" })), rec(goodEntry({ id: "b" }))],
      userMap: MAP,
      nowIso: NOW,
    });
    expect(rows).toHaveLength(1);
    expect(quarantine).toEqual([expect.objectContaining({ reason: "duplicate user+date" })]);
  });

  it("rounds hours to 2dp and defaults ot_overridden, falls back created_at", () => {
    const { rows } = buildTimeEntryRows({
      records: [rec(goodEntry({ totalHours: 7.599, ordinaryHours: 7.599, overtimeHours: 0 }))],
      userMap: MAP,
      nowIso: NOW,
    });
    expect(rows[0]!.total_hours).toBe(7.6);
    expect(rows[0]!.ot_overridden).toBe(false);
    expect(rows[0]!.created_at).toBe(NOW);
  });

  it("nulls a malformed time and negative break", () => {
    const { rows } = buildTimeEntryRows({
      records: [rec(goodEntry({ startTime: "7am", breakMinutes: -5 }))],
      userMap: MAP,
      nowIso: NOW,
    });
    expect(rows[0]!.start_time).toBeNull();
    expect(rows[0]!.break_minutes).toBeNull();
  });

  it("quarantines a duplicate legacy_id across different (user,date) — guards time_entries_legacy_uq", () => {
    const { rows, quarantine } = buildTimeEntryRows({
      records: [
        rec(goodEntry({ id: "dup" }), { date: "2026-06-01" }),
        rec(goodEntry({ id: "dup" }), { date: "2026-06-02" }),
      ],
      userMap: MAP,
      nowIso: NOW,
    });
    expect(rows).toHaveLength(1);
    expect(quarantine).toEqual([expect.objectContaining({ reason: expect.stringContaining("duplicate legacy_id") })]);
  });

  it("validates the ROUNDED triple, so a non-2dp split that would drift past the CHECK is quarantined", () => {
    // raw 5.8858 + 2.7459 = 8.6317 vs total 8.6243 → diff 0.0074 (< 0.011, raw-passes)
    // rounded 5.89 + 2.75 = 8.64 vs 8.62 → diff 0.02 (>= 0.011) → must quarantine
    const { rows, quarantine } = buildTimeEntryRows({
      records: [rec(goodEntry({ totalHours: 8.6243, ordinaryHours: 5.8858, overtimeHours: 2.7459 }))],
      userMap: MAP,
      nowIso: NOW,
    });
    expect(rows).toHaveLength(0);
    expect(quarantine[0]!.reason).toMatch(/!= total/);
  });

  it("keeps the insert column lists in lock-step with the mapped keys", () => {
    const { rows } = buildTimeEntryRows({ records: [rec(goodEntry())], userMap: MAP, nowIso: NOW });
    expect(new Set(TIME_ENTRY_INSERT_COLS)).toEqual(new Set(["tenant_id", ...Object.keys(rows[0]!)]));
    for (const c of TIME_ENTRY_MUTABLE_COLS) expect(TIME_ENTRY_INSERT_COLS).toContain(c);
    expect(TIME_ENTRY_MUTABLE_COLS).not.toContain("user_id");
    expect(TIME_ENTRY_MUTABLE_COLS).not.toContain("work_date");
    expect(TIME_ENTRY_MUTABLE_COLS).not.toContain("legacy_id");
    expect(TIME_ENTRY_MUTABLE_COLS).not.toContain("created_at");
  });
});
