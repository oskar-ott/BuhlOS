import type { TimeEntryStatus } from "./types";

/**
 * ONE status vocabulary for the worker-facing (Phil) hours surfaces —
 * 2026-07-26 owner-directed. Site language per P11: short, calm, apprentice
 * words. Every Phil hours surface that names an entry's status draws from
 * here, so "submitted" never reads three different ways on three screens.
 *
 * Office/admin copy is deliberately NOT routed through this module — the
 * office keeps its own vocabulary (Submitted / Approved / Rejected).
 *
 * Pure: no I/O, no React.
 */
export const STATUS_WORDS: Record<TimeEntryStatus, string> = {
  draft: "Not sent",
  submitted: "Waiting on the office",
  approved: "Approved",
  rejected: "Fix needed",
};

/** The site word for a status, sentence-leading case ("Waiting on the office"). */
export function statusWord(status: TimeEntryStatus): string {
  return STATUS_WORDS[status];
}

/** Mid-sentence form ("these hours are waiting on the office"). */
export function statusPhrase(status: TimeEntryStatus): string {
  const word = STATUS_WORDS[status];
  return word.charAt(0).toLowerCase() + word.slice(1);
}

/**
 * SHORT cell words for the My Day week strip — the same vocabulary compressed
 * so a ~1-of-7-width mobile cell stays legible at the 12px font floor. Only
 * shortened where the full word can't fit; never a different meaning.
 */
export const STATUS_CELL_WORDS: Record<TimeEntryStatus, string> = {
  draft: "not sent",
  submitted: "waiting",
  approved: "approved",
  rejected: "fix",
};
