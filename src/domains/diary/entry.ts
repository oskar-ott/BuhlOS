import type {
  DiaryAmendment,
  DiaryAttendanceRow,
  DiaryDelay,
  DiaryEntry,
} from "./types";

/**
 * Pure diary entry logic (#210) — no I/O, no UI. The integrity rules of the
 * contemporaneous record live here so they are unit-tested directly:
 *
 *   - one-per-date guard (a duplicate (job,date) is rejected, not overwritten)
 *   - delay-requires-reason
 *   - attendance snapshot FREEZE (denormalise + clone, so a later hours change
 *     can never reach into a saved entry)
 *   - append-only amendment shaping (the original is never mutated)
 *
 * Every shaping function returns NEW objects/arrays — callers never share
 * references with the inputs, which is what makes the snapshot freeze real.
 */

/** Find an existing entry for a date (the one-per-date lookup). */
export function findEntryForDate(
  entries: ReadonlyArray<Pick<DiaryEntry, "date">>,
  date: string,
): number {
  return entries.findIndex((e) => e.date === date);
}

/** Whether an entry already exists for (job, date). */
export function hasEntryForDate(
  entries: ReadonlyArray<Pick<DiaryEntry, "date">>,
  date: string,
): boolean {
  return findEntryForDate(entries, date) !== -1;
}

/** A delay flag is only valid with a non-empty reason. Returns the trimmed
 *  reason or throws. An un-flagged delay drops the reason entirely. */
export function normaliseDelay(input: {
  flagged?: boolean;
  reason?: string | null;
}): DiaryDelay {
  const flagged = Boolean(input.flagged);
  if (!flagged) return { flagged: false, reason: null };
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) {
    throw new Error("a flagged delay requires a reason");
  }
  return { flagged: true, reason };
}

/**
 * FREEZE the attendance snapshot: denormalise to (userId, userName, hours,
 * status) and DEEP-COPY every row so the saved entry shares no reference with
 * the live hours data it was derived from. This is the rule that keeps a later
 * hours edit from mutating history.
 */
export function freezeAttendance(
  rows: ReadonlyArray<{
    userId: string;
    userName: string;
    hours: number;
    status: string;
  }>,
): DiaryAttendanceRow[] {
  return rows.map((r) => ({
    userId: String(r.userId),
    userName: String(r.userName),
    hours: Number(r.hours) || 0,
    status: String(r.status),
  }));
}

export interface BuildEntryInput {
  id: string;
  jobId: string;
  date: string;
  happenings: string;
  weatherNote?: string | null;
  delay?: { flagged?: boolean; reason?: string | null };
  attendance?: ReadonlyArray<{
    userId: string;
    userName: string;
    hours: number;
    status: string;
  }>;
  attendanceSource?: { fetchedAt?: string | null; adjusted?: boolean };
  actor: { id: string; name: string; role?: string | null };
  nowIso: string;
}

/**
 * Shape a brand-new diary entry. Pure: it validates the delay rule, freezes the
 * attendance snapshot and stamps the actor. It does NOT enforce the one-per-date
 * guard (the caller checks `hasEntryForDate` against the store) or the
 * future-date rule (date-key.ts) — keeping each invariant in one place.
 */
export function buildDiaryEntry(input: BuildEntryInput): DiaryEntry {
  const delay = normaliseDelay(input.delay ?? {});
  const weatherNote =
    typeof input.weatherNote === "string" && input.weatherNote.trim()
      ? input.weatherNote.trim()
      : null;
  return {
    id: input.id,
    jobId: input.jobId,
    date: input.date,
    happenings: input.happenings.trim(),
    weatherNote,
    delay,
    attendance: freezeAttendance(input.attendance ?? []),
    attendanceSource: {
      fetchedAt: input.attendanceSource?.fetchedAt ?? null,
      adjusted: Boolean(input.attendanceSource?.adjusted),
    },
    amendments: [],
    createdById: input.actor.id,
    createdByName: input.actor.name,
    createdByRole: input.actor.role ?? null,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
    auditLogIds: [],
  };
}

export interface BuildAmendmentInput {
  id: string;
  note?: string | null;
  changes: {
    happenings?: string;
    weatherNote?: string | null;
    delay?: { flagged?: boolean; reason?: string | null };
  };
  actor: { id: string; name: string; role?: string | null };
  nowIso: string;
}

/**
 * Shape an append-only amendment. The `delay` change (if present) is run through
 * the same delay-requires-reason rule. Returns ONLY the amendment delta — the
 * caller appends it to the entry's `amendments[]` WITHOUT touching the original
 * fields. Throws if `changes` is empty (nothing to amend).
 */
export function buildAmendment(input: BuildAmendmentInput): DiaryAmendment {
  const changes: Record<string, unknown> = {};
  if (typeof input.changes.happenings === "string") {
    const h = input.changes.happenings.trim();
    if (h) changes.happenings = h;
  }
  if (input.changes.weatherNote !== undefined) {
    const w =
      typeof input.changes.weatherNote === "string" && input.changes.weatherNote.trim()
        ? input.changes.weatherNote.trim()
        : null;
    changes.weatherNote = w;
  }
  if (input.changes.delay !== undefined) {
    changes.delay = normaliseDelay(input.changes.delay);
  }
  if (Object.keys(changes).length === 0) {
    throw new Error("an amendment must change at least one field");
  }
  return {
    id: input.id,
    createdAt: input.nowIso,
    createdById: input.actor.id,
    createdByName: input.actor.name,
    createdByRole: input.actor.role ?? null,
    note:
      typeof input.note === "string" && input.note.trim() ? input.note.trim() : null,
    changes,
  };
}

/**
 * Append an amendment to an entry WITHOUT mutating the original — returns a new
 * entry with the amendment pushed and `updatedAt` bumped; every original field
 * keeps its value. This is the append-only invariant in one place.
 */
export function appendAmendment(
  entry: DiaryEntry,
  amendment: DiaryAmendment,
  nowIso: string,
): DiaryEntry {
  return {
    ...entry,
    amendments: [...(entry.amendments ?? []), amendment],
    updatedAt: nowIso,
  };
}

/** Sort entries newest-date first (the register order). Pure, non-mutating. */
export function sortByDateDesc<T extends { date: string }>(entries: ReadonlyArray<T>): T[] {
  return entries.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
