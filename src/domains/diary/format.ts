import type { DiaryAmendment, DiaryEntry } from "./types";

/**
 * Pure display helpers for the site diary (#210). No I/O, no React — used by the
 * presenter and unit-tested directly. Site language (P11): plain words a
 * supervisor reads, no enterprise jargon.
 */

/** A one-line attendance summary: "3 on site · 22.5h". Empty → "No attendance". */
export function attendanceSummary(entry: Pick<DiaryEntry, "attendance">): string {
  const rows = entry.attendance ?? [];
  if (rows.length === 0) return "No attendance recorded";
  const totalHours = rows.reduce((sum, r) => sum + (Number(r.hours) || 0), 0);
  const people = rows.length === 1 ? "1 on site" : `${rows.length} on site`;
  const hours = Math.round(totalHours * 100) / 100;
  return `${people} · ${hours}h`;
}

/**
 * Pull the latest value of an amendable field, walking amendments in order so a
 * later amendment wins. The ORIGINAL value is the seed — the original entry is
 * never mutated, so this is how the "current" view is derived. The original
 * stays visible in the UI; this is only for showing what the field now reads.
 */
export function latestValue<K extends "happenings" | "weatherNote">(
  entry: DiaryEntry,
  field: K,
): DiaryEntry[K] {
  let value = entry[field];
  for (const a of entry.amendments ?? []) {
    if (a.changes && Object.prototype.hasOwnProperty.call(a.changes, field)) {
      value = a.changes[field] as DiaryEntry[K];
    }
  }
  return value;
}

/** Whether an entry carries any amendments (drives the "Amended" badge). */
export function isAmended(entry: Pick<DiaryEntry, "amendments">): boolean {
  return (entry.amendments ?? []).length > 0;
}

/** A short label for an amendment's changed fields ("happenings, delay"). */
export function amendmentChangeLabel(amendment: DiaryAmendment): string {
  const keys = Object.keys(amendment.changes ?? {});
  if (keys.length === 0) return "no fields";
  const labels: Record<string, string> = {
    happenings: "happenings",
    weatherNote: "weather",
    delay: "delay",
  };
  return keys.map((k) => labels[k] ?? k).join(", ");
}
