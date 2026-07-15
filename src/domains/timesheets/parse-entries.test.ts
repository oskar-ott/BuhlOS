import { describe, expect, it } from "vitest";
import { parseTimeEntryListLenient } from "./parse-entries";

/**
 * A single malformed historical row must NOT blank a worker's whole Hours /
 * My Day screen (the "Unexpected response shape" prod bug). Bad rows are
 * dropped + counted; valid rows survive; only a wrong top-level shape errors.
 */

function validEntry(over: Record<string, unknown> = {}) {
  return {
    id: "te_1",
    userId: "u_1",
    date: "2026-07-14",
    totalHours: 8,
    ordinaryHours: 8,
    overtimeHours: 0,
    status: "submitted",
    allocations: [{ jobId: "j1", hours: 8 }],
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...over,
  };
}

describe("parseTimeEntryListLenient", () => {
  it("keeps all rows when every entry is valid", () => {
    const r = parseTimeEntryListLenient({ entries: [validEntry({ id: "a" }), validEntry({ id: "b" })] });
    expect(r).toMatchObject({ ok: true, dropped: 0 });
    if (r.ok) expect(r.entries.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("drops a single malformed row (empty allocations) but keeps the good ones", () => {
    const r = parseTimeEntryListLenient({
      entries: [validEntry({ id: "good" }), validEntry({ id: "bad", allocations: [] })],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dropped).toBe(1);
      expect(r.entries.map((e) => e.id)).toEqual(["good"]);
    }
  });

  it("drops rows with a null numeric field (legacy data) without breaking the list", () => {
    const r = parseTimeEntryListLenient({
      entries: [validEntry({ id: "good" }), validEntry({ id: "bad", totalHours: null })],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dropped).toBe(1);
      expect(r.entries).toHaveLength(1);
    }
  });

  it("an empty list is fine (ok, zero entries)", () => {
    expect(parseTimeEntryListLenient({ entries: [] })).toEqual({ ok: true, entries: [], dropped: 0 });
  });

  it("only a wrong TOP-LEVEL shape is a hard error", () => {
    expect(parseTimeEntryListLenient(null).ok).toBe(false);
    expect(parseTimeEntryListLenient([]).ok).toBe(false);
    expect(parseTimeEntryListLenient({}).ok).toBe(false);
    expect(parseTimeEntryListLenient({ entries: null }).ok).toBe(false);
    expect(parseTimeEntryListLenient("nope").ok).toBe(false);
  });
});
