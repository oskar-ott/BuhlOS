import { describe, expect, it } from "vitest";
import {
  SAVED_ENTRY_TTL_MS,
  hasSavedEntryForDate,
  readSavedEntries,
  recordSavedEntry,
  type StorageLike,
} from "./saved-entries-journal";
import type { TimeEntry } from "./types";

/**
 * The persistent read-your-writes journal (2026-08-06). Node-env tests with an
 * injected fake storage — the module must behave identically whether backed by
 * real localStorage or nothing at all (server render, private mode).
 */

function fakeStore(initial?: Record<string, string>): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial ?? {}));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

function entry(overrides: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: "e1",
    userId: "u1",
    date: "2026-08-06",
    totalHours: 7.6,
    ordinaryHours: 7.6,
    overtimeHours: 0,
    status: "submitted",
    allocations: [{ jobId: "j1", hours: 7.6 }],
    createdAt: "2026-08-06T08:00:00.000Z",
    updatedAt: "2026-08-06T08:00:00.000Z",
    ...overrides,
  } as TimeEntry;
}

const T0 = 1_800_000_000_000;

describe("saved-entries journal", () => {
  it("returns a recorded entry for its own user", () => {
    const store = fakeStore();
    recordSavedEntry(entry(), T0, store);
    const got = readSavedEntries("u1", T0 + 1000, store);
    expect(got.map((e) => e.id)).toEqual(["e1"]);
    expect(hasSavedEntryForDate("u1", "2026-08-06", T0 + 1000, store)).toBe(true);
    expect(hasSavedEntryForDate("u1", "2026-08-05", T0 + 1000, store)).toBe(false);
  });

  it("never returns another user's entries (shared-device safety)", () => {
    const store = fakeStore();
    recordSavedEntry(entry({ userId: "u1" }), T0, store);
    expect(readSavedEntries("u2", T0, store)).toEqual([]);
    expect(readSavedEntries(null, T0, store)).toEqual([]);
    expect(readSavedEntries("", T0, store)).toEqual([]);
  });

  it("replaces the record for the same user + date (latest save wins)", () => {
    const store = fakeStore();
    recordSavedEntry(entry({ id: "old", totalHours: 4 }), T0, store);
    recordSavedEntry(entry({ id: "new", totalHours: 8 }), T0 + 5000, store);
    const got = readSavedEntries("u1", T0 + 6000, store);
    expect(got).toHaveLength(1);
    expect(got[0]!.id).toBe("new");
  });

  it("keeps separate dates and users side by side", () => {
    const store = fakeStore();
    recordSavedEntry(entry({ id: "a", date: "2026-08-05" }), T0, store);
    recordSavedEntry(entry({ id: "b", date: "2026-08-06" }), T0, store);
    recordSavedEntry(entry({ id: "c", userId: "u2" }), T0, store);
    expect(readSavedEntries("u1", T0, store).map((e) => e.id).sort()).toEqual(["a", "b"]);
    expect(readSavedEntries("u2", T0, store).map((e) => e.id)).toEqual(["c"]);
  });

  it("expires records after the TTL", () => {
    const store = fakeStore();
    recordSavedEntry(entry(), T0, store);
    expect(readSavedEntries("u1", T0 + SAVED_ENTRY_TTL_MS - 1, store)).toHaveLength(1);
    expect(readSavedEntries("u1", T0 + SAVED_ENTRY_TTL_MS + 1, store)).toEqual([]);
  });

  it("drops records stamped in the future (clock-skew garbage)", () => {
    const store = fakeStore();
    recordSavedEntry(entry(), T0 + 10 * 60_000, store);
    expect(readSavedEntries("u1", T0, store)).toEqual([]);
  });

  it("caps the journal at 20 records, dropping the oldest", () => {
    const store = fakeStore();
    for (let i = 0; i < 25; i++) {
      const d = String(i + 1).padStart(2, "0");
      recordSavedEntry(entry({ id: `e${i}`, date: `2026-07-${d}` }), T0 + i, store);
    }
    const got = readSavedEntries("u1", T0 + 100, store);
    expect(got).toHaveLength(20);
    expect(got.map((e) => e.id)).not.toContain("e0");
    expect(got.map((e) => e.id)).toContain("e24");
  });

  it("treats corrupt or non-array journal contents as empty", () => {
    for (const raw of ["not json", '{"an":"object"}', '["strings"]', '[{"savedAtMs":"x"}]']) {
      const store = fakeStore({ "buhlos.hours.savedEntries.v1": raw });
      expect(readSavedEntries("u1", T0, store)).toEqual([]);
      // and a record on top of the corruption still round-trips
      recordSavedEntry(entry(), T0, store);
      expect(readSavedEntries("u1", T0, store)).toHaveLength(1);
    }
  });

  it("skips journal items that fail the TimeEntry shape gate", () => {
    const store = fakeStore();
    recordSavedEntry(entry({ id: "good" }), T0, store);
    const raw = JSON.parse(store.data.get("buhlos.hours.savedEntries.v1")!);
    raw.push({ savedAtMs: T0, entry: { id: "bad", userId: "u1" } }); // missing fields
    store.data.set("buhlos.hours.savedEntries.v1", JSON.stringify(raw));
    expect(readSavedEntries("u1", T0, store).map((e) => e.id)).toEqual(["good"]);
  });

  it("is a silent no-op without storage (server render / private mode)", () => {
    expect(() => recordSavedEntry(entry(), T0, null)).not.toThrow();
    expect(readSavedEntries("u1", T0, null)).toEqual([]);
    expect(hasSavedEntryForDate("u1", "2026-08-06", T0, null)).toBe(false);
  });

  it("swallows a storage write failure (quota)", () => {
    const store = fakeStore();
    store.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(() => recordSavedEntry(entry(), T0, store)).not.toThrow();
  });
});
