import { shortDayLabel } from "./weekly-review";

/**
 * The days a payroll read refused because they couldn't be read — parsed off
 * the server's refusal (`days`, api/_lib/payroll-inputs.js, 2026-10-12) so a
 * send or download screen can NAME them and offer "send without them" instead
 * of a refusal nobody can act on. Only `canSkip` days (unreadable and long
 * settled) may be left off; a day that changed in the last minute is waited
 * out by the send itself. PURE.
 */
export interface UnreadableDay {
  /** "userId|YYYY-MM-DD" — what the server takes back as `skipUnreadable`. */
  key: string;
  workerName: string;
  date: string;
  canSkip: boolean;
}

export function parseUnreadableDays(body: unknown): UnreadableDay[] {
  if (!body || typeof body !== "object") return [];
  const raw = (body as Record<string, unknown>).days;
  if (!Array.isArray(raw)) return [];
  const out: UnreadableDay[] = [];
  for (const d of raw) {
    if (!d || typeof d !== "object") continue;
    const r = d as Record<string, unknown>;
    const userId = typeof r.userId === "string" ? r.userId : "";
    const date = typeof r.date === "string" ? r.date : "";
    if (!userId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    out.push({
      key: `${userId}|${date}`,
      workerName: typeof r.workerName === "string" && r.workerName ? r.workerName : "Someone",
      date,
      canSkip: r.canSkip === true,
    });
  }
  return out;
}

/** "Dylan Sinclair · Fri 9 Oct" — one per day, in the sheet's day format. */
export function unreadableDayLabel(d: UnreadableDay): string {
  return `${d.workerName} · ${shortDayLabel(d.date)}`;
}

/** True when every named day can be left off — so "send without them" can
 *  actually go through rather than refuse again on a day it didn't name. */
export function allSkippable(days: ReadonlyArray<UnreadableDay>): boolean {
  return days.length > 0 && days.every((d) => d.canSkip);
}
