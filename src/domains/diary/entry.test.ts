import { describe, expect, it } from "vitest";
import {
  appendAmendment,
  buildAmendment,
  buildDiaryEntry,
  findEntryForDate,
  freezeAttendance,
  hasEntryForDate,
  normaliseDelay,
  sortByDateDesc,
} from "./entry";
import type { DiaryEntry } from "./types";

const actor = { id: "u_boss", name: "Boss", role: "boss" };

function baseInput(over: Partial<Parameters<typeof buildDiaryEntry>[0]> = {}) {
  return {
    id: "di_1",
    jobId: "job-1",
    date: "2026-06-15",
    happenings: "Rough-in level 2",
    actor,
    nowIso: "2026-06-15T08:00:00.000Z",
    ...over,
  };
}

/* ----------------------------------------------------------------------------
 * delay-requires-reason
 * -------------------------------------------------------------------------- */

describe("normaliseDelay", () => {
  it("an un-flagged delay drops the reason", () => {
    expect(normaliseDelay({ flagged: false, reason: "ignored" })).toEqual({
      flagged: false,
      reason: null,
    });
    expect(normaliseDelay({})).toEqual({ flagged: false, reason: null });
  });

  it("a flagged delay requires a non-empty reason", () => {
    expect(() => normaliseDelay({ flagged: true })).toThrow(/reason/);
    expect(() => normaliseDelay({ flagged: true, reason: "   " })).toThrow(/reason/);
  });

  it("trims and keeps a valid reason", () => {
    expect(normaliseDelay({ flagged: true, reason: "  Rain stopped concrete  " })).toEqual({
      flagged: true,
      reason: "Rain stopped concrete",
    });
  });
});

describe("buildDiaryEntry — delay rule", () => {
  it("rejects a flagged delay without a reason", () => {
    expect(() => buildDiaryEntry(baseInput({ delay: { flagged: true } }))).toThrow(/reason/);
  });

  it("builds with a clean default delay when unflagged", () => {
    const entry = buildDiaryEntry(baseInput());
    expect(entry.delay).toEqual({ flagged: false, reason: null });
  });
});

/* ----------------------------------------------------------------------------
 * one-per-date guard
 * -------------------------------------------------------------------------- */

describe("one-per-date guard", () => {
  const entries: Array<Pick<DiaryEntry, "date">> = [{ date: "2026-06-15" }, { date: "2026-06-14" }];

  it("finds an existing date and reports its index", () => {
    expect(findEntryForDate(entries, "2026-06-15")).toBe(0);
    expect(findEntryForDate(entries, "2026-06-14")).toBe(1);
    expect(findEntryForDate(entries, "2026-06-13")).toBe(-1);
  });

  it("hasEntryForDate reflects presence", () => {
    expect(hasEntryForDate(entries, "2026-06-15")).toBe(true);
    expect(hasEntryForDate(entries, "2026-06-10")).toBe(false);
  });
});

/* ----------------------------------------------------------------------------
 * attendance snapshot FREEZE (the headline integrity rule)
 * -------------------------------------------------------------------------- */

describe("attendance snapshot freeze", () => {
  it("denormalises to (userId,userName,hours,status) and drops extra fields", () => {
    const live = [
      { userId: "u1", userName: "Sam", hours: 8, status: "approved", rate: 999, secret: "x" },
    ];
    const frozen = freezeAttendance(live as never);
    expect(frozen).toEqual([{ userId: "u1", userName: "Sam", hours: 8, status: "approved" }]);
  });

  it("a LATER hours change does NOT mutate a saved entry", () => {
    const liveRows = [{ userId: "u1", userName: "Sam", hours: 8, status: "submitted" }];
    const entry = buildDiaryEntry(baseInput({ attendance: liveRows }));

    // Simulate the hours system editing the SAME source rows after the save.
    liveRows[0]!.hours = 2;
    liveRows[0]!.status = "rejected";
    liveRows.push({ userId: "u2", userName: "Late", hours: 4, status: "submitted" });

    // The saved snapshot is untouched — frozen at save.
    expect(entry.attendance).toEqual([
      { userId: "u1", userName: "Sam", hours: 8, status: "submitted" },
    ]);
  });

  it("stamps attendanceSource provenance", () => {
    const entry = buildDiaryEntry(
      baseInput({ attendanceSource: { fetchedAt: "2026-06-15T07:55:00.000Z", adjusted: true } }),
    );
    expect(entry.attendanceSource).toEqual({
      fetchedAt: "2026-06-15T07:55:00.000Z",
      adjusted: true,
    });
  });
});

/* ----------------------------------------------------------------------------
 * append-only amendments (the original is never mutated)
 * -------------------------------------------------------------------------- */

describe("append-only amendments", () => {
  it("buildAmendment shapes only the changed fields + actor stamp", () => {
    const amendment = buildAmendment({
      id: "dia_1",
      note: "  corrected the slab note  ",
      changes: { happenings: "  Rough-in level 2 + slab pour  " },
      actor,
      nowIso: "2026-06-16T09:00:00.000Z",
    });
    expect(amendment.changes).toEqual({ happenings: "Rough-in level 2 + slab pour" });
    expect(amendment.note).toBe("corrected the slab note");
    expect(amendment.createdById).toBe("u_boss");
    expect(amendment.createdAt).toBe("2026-06-16T09:00:00.000Z");
  });

  it("a delay change in an amendment is run through delay-requires-reason", () => {
    expect(() =>
      buildAmendment({
        id: "dia_x",
        changes: { delay: { flagged: true } },
        actor,
        nowIso: "2026-06-16T09:00:00.000Z",
      }),
    ).toThrow(/reason/);
  });

  it("rejects an empty amendment", () => {
    expect(() =>
      buildAmendment({ id: "dia_y", changes: {}, actor, nowIso: "2026-06-16T09:00:00.000Z" }),
    ).toThrow(/at least one field/);
  });

  it("appendAmendment leaves the ORIGINAL fields unchanged and pushes the amendment", () => {
    const entry = buildDiaryEntry(baseInput({ happenings: "Original text" }));
    const amendment = buildAmendment({
      id: "dia_2",
      changes: { happenings: "New text" },
      actor,
      nowIso: "2026-06-16T09:00:00.000Z",
    });
    const next = appendAmendment(entry, amendment, "2026-06-16T09:00:00.000Z");

    // Original happenings UNCHANGED — append-only.
    expect(next.happenings).toBe("Original text");
    expect(next.amendments).toHaveLength(1);
    expect(next.amendments[0]!.changes.happenings).toBe("New text");
    expect(next.updatedAt).toBe("2026-06-16T09:00:00.000Z");
    // The input entry object is not mutated.
    expect(entry.amendments).toHaveLength(0);
  });

  it("stacks multiple amendments in order", () => {
    let entry = buildDiaryEntry(baseInput());
    entry = appendAmendment(
      entry,
      buildAmendment({ id: "a1", changes: { happenings: "v2" }, actor, nowIso: "2026-06-16T09:00:00.000Z" }),
      "2026-06-16T09:00:00.000Z",
    );
    entry = appendAmendment(
      entry,
      buildAmendment({ id: "a2", changes: { happenings: "v3" }, actor, nowIso: "2026-06-17T09:00:00.000Z" }),
      "2026-06-17T09:00:00.000Z",
    );
    expect(entry.amendments.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(entry.happenings).toBe("Rough-in level 2"); // still the original
  });
});

describe("sortByDateDesc", () => {
  it("orders newest date first without mutating", () => {
    const input = [{ date: "2026-06-14" }, { date: "2026-06-16" }, { date: "2026-06-15" }];
    const out = sortByDateDesc(input);
    expect(out.map((e) => e.date)).toEqual(["2026-06-16", "2026-06-15", "2026-06-14"]);
    expect(input.map((e) => e.date)).toEqual(["2026-06-14", "2026-06-16", "2026-06-15"]);
  });
});
