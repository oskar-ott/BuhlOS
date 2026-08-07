import type { TimeEntryStatus } from "./types";

/**
 * Pure formatting helpers for the timesheets domain. Kept separate from
 * service.ts so they can be tree-shaken into client bundles without pulling
 * the validation logic along.
 */

/**
 * The base/overtime split label for a single day's entry (#130).
 *
 * The server (api/_lib/time-entries.js `autoSplitOT`) already splits a long
 * day into ordinary + overtime and STORES both on every entry. This presenter
 * is the SINGLE source of the split's display numbers across every screen
 * (admin approvals queue, weekly board, Phil week) — it only ever reads the
 * STORED fields, never re-derives the split client-side.
 *
 * Returns `null` (so the caller renders byte-identical to before) when:
 *   - there is no overtime (`overtimeHours <= 0`) — a 7.6h or exactly 8.0h day
 *     looks exactly as it does today, zero added visual noise (P10); OR
 *   - the stored split is internally inconsistent — HONESTY GUARD (P7): if
 *     `|ordinary + overtime - total| > 0.01` (legacy / garbage data) we refuse
 *     to render an invented split and show the total only.
 *
 * Two audiences read the SAME numbers, differing only in wording:
 *   - "office" (default): `8h + 2h OT` — compact, admin-side.
 *   - "worker" (Phil): `8h + 2h overtime` — worker words, no "OT" jargon (P11).
 */
export interface OtSplitParts {
  ordinaryHours: number;
  overtimeHours: number;
  totalHours: number;
}

export function otSplitLabel(
  entry: OtSplitParts,
  opts?: { audience?: "office" | "worker" },
): string | null {
  const ordinary = Number(entry.ordinaryHours);
  const overtime = Number(entry.overtimeHours);
  const total = Number(entry.totalHours);
  if (!Number.isFinite(ordinary) || !Number.isFinite(overtime) || !Number.isFinite(total)) {
    return null;
  }
  // No overtime → no split. A standard day reads exactly as today.
  if (overtime <= 0) return null;
  // HONESTY GUARD (P7): a stored split that doesn't reconcile to the total is
  // legacy/garbage — never show an invented split, just fall back to the total.
  if (Math.abs(ordinary + overtime - total) > 0.01) return null;
  const suffix = opts?.audience === "worker" ? "overtime" : "OT";
  return `${formatHoursLabel(ordinary)} + ${formatHoursLabel(overtime)} ${suffix}`;
}

/**
 * Render decimal hours as `Xh Ym`. Examples:
 *   7.6   → "7h 36m"
 *   8     → "8h"
 *   8.25  → "8h 15m"
 *   0.5   → "30m"
 *   0     → "0h"
 *
 * The legacy server only stores decimal hours; the display string is purely
 * client-side. Hour and minute components are clamped to non-negative.
 */
export function formatHoursLabel(decimalHours: number): string {
  if (!Number.isFinite(decimalHours) || decimalHours <= 0) return "0h";
  const totalMinutes = Math.round(decimalHours * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes - hours * 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

/**
 * Chip label for a standard-day OT add-on (owner-directed 2026-08-07) —
 * duration shorthand sized for a one-thumb chip: 0.5 → "+30m", 1 → "+1h",
 * 1.5 → "+1½h", 2 → "+2h". The ½ glyph keeps the ninety-minute chip as
 * narrow as its neighbours; any other value falls back to the plain
 * `+Xh Ym` dialect (never a decimal — that's the incident this exists for).
 */
export function otChipLabel(addOnHours: number): string {
  const totalMinutes = Math.round(addOnHours * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes - hours * 60;
  if (hours === 0) return `+${minutes}m`;
  if (minutes === 30) return `+${hours}½h`;
  if (minutes === 0) return `+${hours}h`;
  return `+${hours}h ${minutes}m`;
}

/**
 * The submit-bar echo while an OT chip rides the standard day — the derived
 * truth the worker checks by eye instead of computing in their head:
 * "Submit 8h 36m — standard + 1h OT". Wording is the owner-approved copy
 * verbatim ("OT" here is the site's own shorthand — workers say it, and the
 * uppercase sub-line has no room for "overtime"). The caller passes the
 * derived total (standardDayPlusOt) plus the add-on so this stays a pure
 * formatter with no service import.
 */
export function standardDayOtEcho(totalHours: number, addOnHours: number): string {
  return `Submit ${formatHoursLabel(totalHours)} — standard + ${formatHoursLabel(addOnHours)} OT`;
}

/**
 * The honest "the office changed your hours" line for ONE day.
 *
 * When the office uses "fix it and approve" (api/time-entries-amend-approve.js)
 * the entry carries `amendedFrom` — the before picture — alongside the new
 * numbers. This presenter is the SINGLE source of that line's wording, so the
 * worker's screen and the office's queue can never drift apart about what a
 * change says.
 *
 * Returns null when nothing was amended, so an untouched day renders exactly as
 * it does today (P10 — the line only costs budget when there is something real
 * to say).
 *
 * Wording is site language (P11): "Adjusted by the office", never "amended
 * by administrator". The before → after arrow uses the duration dialect
 * ("8h 22m → 8h 36m") — never decimals, which is the mis-read that started
 * this whole feature.
 */
export interface AmendmentParts {
  totalHours: number;
  amendedFrom?: { totalHours: number } | null;
  amendedReason?: string | null;
}

export function amendmentLine(entry: AmendmentParts): string | null {
  const from = Number(entry.amendedFrom?.totalHours);
  const to = Number(entry.totalHours);
  // HONESTY GUARD (P7): no amendment recorded, or the stored before-total is
  // unusable — say nothing rather than invent a change.
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const reason = entry.amendedReason?.trim();
  // The totals can legitimately match when only the job split moved; claiming
  // "8h → 8h" would read as a bug, so the line states the settled time and
  // lets the reason carry the what.
  const change =
    Math.abs(from - to) > 0.005
      ? `${formatHoursLabel(from)} → ${formatHoursLabel(to)}`
      : formatHoursLabel(to);
  return reason
    ? `Adjusted by the office — ${change}: ${reason}`
    : `Adjusted by the office — ${change}`;
}

/**
 * Human label for a status, used on Pill / StatusBadge components.
 */
export function statusLabel(status: TimeEntryStatus): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "submitted":
      return "Submitted";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
  }
}

/**
 * Tone mapping for the rebuild's StatusBadge / Pill. Matches doc 13
 * §Visual tokens.
 */
export function statusTone(status: TimeEntryStatus): "neutral" | "info" | "success" | "danger" {
  switch (status) {
    case "draft":
      return "neutral";
    case "submitted":
      return "info";
    case "approved":
      return "success";
    case "rejected":
      return "danger";
  }
}

/**
 * Display the YYYY-MM-DD date as a friendly label like "Mon 4 May 2026".
 * No locale knob — the business is single-tenant Australian today.
 */
export function formatDateLabel(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const d = new Date(date + "T00:00:00");
  return d.toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Compact friendly date label WITHOUT the year — "Fri 19 Jun". Used where the
 * year is obvious from context, e.g. the "logged …" sub-line on the My Day job
 * picker, which only ever names a recent date. Same en-AU shape as
 * formatDateLabel minus the year; malformed input is returned unchanged.
 */
export function formatShortDateLabel(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const d = new Date(date + "T00:00:00");
  return d.toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/**
 * Title for the My Day quick-log action, naming the day being logged so the
 * button is never generic. Today → "Log today's hours"; any other date →
 * "Log Tuesday's hours" (the weekday of that date) — so tapping a past day in
 * the week strip relabels the action to that day rather than claiming "today"
 * or the vague "this day". `todayISO` is the worker's local today (the caller
 * passes localDateString()), keeping the today-check timezone-correct.
 */
export function logActionTitle(date: string, todayISO: string): string {
  if (date === todayISO) return "Log today's hours";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "Log hours for this day";
  const weekday = new Date(date + "T00:00:00").toLocaleDateString("en-AU", {
    weekday: "long",
  });
  return `Log ${weekday}'s hours`;
}

/**
 * Display an ISO timestamp as a short local-time label like "12 May, 4:32 pm".
 * Used on admin queue rows for submittedAt / approvedAt / rejectedAt.
 */
export function formatTimestamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}
