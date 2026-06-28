/**
 * Defect liability period (DLP) — pure status helper (#235).
 *
 * A handed-over job enters its defect liability period: a window during which
 * the builder/owner can raise callback defects against the work. This module is
 * the single home for all DLP date math so the job hub, the snag-origin marker
 * and any future command-centre exception read from ONE definition.
 *
 * Two job fields drive it (both additive, admin-set, nullable):
 *   - handoverDate         — YYYY-MM-DD, the day the job was handed over
 *   - defectPeriodEndsAt   — YYYY-MM-DD, the last day of the defect window
 *
 * Both must be present for a DLP to exist. Absent / blank → `not_set`; we never
 * default or infer a window (an unset job behaves exactly as today, AC#5).
 *
 * `today` is a Sydney YYYY-MM-DD string (callers pass `sydneyToday()`), so all
 * comparisons are plain lexical string comparisons on the YYYY-MM-DD shape —
 * no Date parsing, no timezone drift. The day OF handover and the LAST day of
 * the window are both inside the period (inclusive on both ends).
 *
 * Cross-ref:
 *   api/site-visits.js — the `Australia/Sydney` Intl sydneyToday() pattern
 *   api/snags.js createSnag — stamps origin:'post_handover' at create time
 */

export type DlpStatus =
  | { state: "not_set" }
  | { state: "in_dlp"; daysRemaining: number }
  | { state: "expired"; endedAt: string };

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function isYmd(v: unknown): v is string {
  return typeof v === "string" && YMD.test(v);
}

/** Whole days from `from` (inclusive) to `to` (inclusive of the end day),
 *  computed in UTC at midnight so DST never shifts the count. Both must be
 *  valid YYYY-MM-DD strings. */
function daysBetweenInclusive(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  const diff = Math.round((b - a) / 86_400_000);
  // +1 so the last day of the window counts as one remaining day, matching
  // the inclusive "today is still in the period when today === endsAt" rule.
  return diff + 1;
}

/**
 * Resolve a job's defect-liability state for `today` (a Sydney YYYY-MM-DD).
 *
 * - Missing/blank/malformed handoverDate OR defectPeriodEndsAt → `not_set`.
 * - today on or after handover AND on or before the end → `in_dlp` with
 *   `daysRemaining` (1 on the last day, never below 1 while in-window).
 * - today strictly after the end → `expired` (carries the end date).
 * - today strictly before handover (a future handover) → `not_set` — the
 *   window hasn't started, so there's nothing to show yet.
 *
 * @param job  any object that may carry handoverDate / defectPeriodEndsAt
 * @param today Sydney YYYY-MM-DD string
 */
export function dlpStatus(
  job: { handoverDate?: string | null; defectPeriodEndsAt?: string | null } | null | undefined,
  today: string,
): DlpStatus {
  const handover = job && job.handoverDate;
  const endsAt = job && job.defectPeriodEndsAt;
  if (!isYmd(handover) || !isYmd(endsAt) || !isYmd(today)) {
    return { state: "not_set" };
  }
  // Future handover — the window has not opened. Nothing to surface.
  if (today < handover) return { state: "not_set" };
  if (today > endsAt) return { state: "expired", endedAt: endsAt };
  return { state: "in_dlp", daysRemaining: daysBetweenInclusive(today, endsAt) };
}
