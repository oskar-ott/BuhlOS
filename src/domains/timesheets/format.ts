import type { TimeEntryStatus } from "./types";

/**
 * Pure formatting helpers for the timesheets domain. Kept separate from
 * service.ts so they can be tree-shaken into client bundles without pulling
 * the validation logic along.
 */

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
