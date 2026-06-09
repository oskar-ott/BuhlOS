import type { TimeEntry } from "@/domains/timesheets/types";
import { addDays, weekStartOf } from "@/domains/timesheets/service";

/**
 * Pure logic for the My Day "This week" payroll strip (the approved final
 * Phil My Day design — a Mon–Sun timesheet at a glance).
 *
 * Honest by construction: every cell is derived from the worker's real time
 * entries + the calendar. Nothing is fabricated —
 *   - logged   : a real entry exists for that date (its hours are shown)
 *   - today    : the cell IS today (prompts "log now" when no entry yet)
 *   - off      : a weekend with no entry (most don't work Sat/Sun)
 *   - miss     : a PAST weekday with no entry — a soft "you haven't logged
 *                this" nudge, never a claim the worker did anything wrong
 *   - upcoming : a future weekday in this week (nothing to show yet)
 *
 * The rolling 7-day window the page already fetches always covers this week's
 * Monday→today (the week is at most six days behind today), so no extra fetch
 * is needed.
 */
export type WeekDayState = "logged" | "today" | "miss" | "off" | "upcoming";

export interface WeekDayCell {
  /** YYYY-MM-DD. */
  date: string;
  /** Short weekday label, e.g. "Mon". */
  weekday: string;
  /** Logged hours for the day, or null when nothing is logged. */
  hours: number | null;
  state: WeekDayState;
  /** Short status word shown under the hours, e.g. "logged" / "log now". */
  statusWord: string;
}

export interface PhilWeek {
  /** Seven cells, Monday → Sunday. */
  days: WeekDayCell[];
  /** Sum of logged hours across the week. */
  totalHours: number;
  /** True when today has a real entry. */
  todayLogged: boolean;
  /** Monday (YYYY-MM-DD) of the week containing today. */
  weekStart: string;
  /** Sunday (YYYY-MM-DD) of the week. */
  weekEnd: string;
  /** ISO-8601 week number (1–53). */
  weekNumber: number;
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** ISO-8601 week number for a YYYY-MM-DD date (Monday-anchored, Thursday rule). */
export function isoWeekNumber(dateISO: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return 0;
  const d = new Date(dateISO + "T00:00:00Z");
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  // Shift to the Thursday of this week — ISO weeks are owned by their Thursday.
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  return 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
}

export function buildPhilWeek(
  entries: ReadonlyArray<Pick<TimeEntry, "date" | "totalHours">>,
  opts: { todayISO: string },
): PhilWeek {
  const { todayISO } = opts;
  const weekStart = weekStartOf(todayISO);

  // Sum hours per date (defensive against more than one entry on a date).
  const hoursByDate = new Map<string, number>();
  for (const e of entries) {
    if (!e.date) continue;
    hoursByDate.set(e.date, (hoursByDate.get(e.date) ?? 0) + (e.totalHours ?? 0));
  }

  const days: WeekDayCell[] = [];
  let totalHours = 0;

  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const weekday = WEEKDAY_LABELS[i]!;
    const isWeekend = i >= 5; // Sat=5, Sun=6
    const logged = hoursByDate.has(date);
    const hours = logged ? hoursByDate.get(date)! : null;
    if (logged) totalHours += hours!;

    let state: WeekDayState;
    let statusWord: string;
    if (date === todayISO) {
      state = "today";
      statusWord = logged ? "today" : "log now";
    } else if (logged) {
      state = "logged";
      statusWord = "logged";
    } else if (isWeekend) {
      // A weekend with no entry is off — whether it's already past or still
      // to come — never flagged as a "missing" weekday.
      state = "off";
      statusWord = "off";
    } else if (date > todayISO) {
      state = "upcoming";
      statusWord = "—";
    } else {
      state = "miss";
      statusWord = "not logged";
    }

    days.push({ date, weekday, hours, state, statusWord });
  }

  return {
    days,
    totalHours,
    todayLogged: hoursByDate.has(todayISO),
    weekStart,
    weekEnd: addDays(weekStart, 6),
    weekNumber: isoWeekNumber(weekStart),
  };
}
