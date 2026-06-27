import type { TimeEntry } from "@/domains/timesheets/types";
import { addDays, weekStartOf } from "@/domains/timesheets/service";

/**
 * Pure logic for the My Day "This week" payroll strip (the approved final
 * Phil My Day design — a Mon–Sun timesheet at a glance).
 *
 * Honest by construction: every cell is derived from the worker's real time
 * entries + the calendar. Nothing is fabricated —
 *   - logged   : a real (approved/waiting) entry exists for that date — reads as
 *                a green "done" cell with its hours, INCLUDING today's once it's
 *                logged; the status word tells the truth (approved / waiting)
 *   - fix      : the entry was REJECTED — the one state that needs the
 *                worker's hand, so it reads red instead of a green "logged"
 *   - today    : today with nothing logged yet (prompts "log now"); once logged
 *                it turns into a green "logged" cell
 *   - miss     : a PAST day with no entry — a soft "you haven't logged this"
 *                nudge, never a claim the worker did anything wrong. Weekends
 *                are loggable like weekdays (tap to log if you worked Sat/Sun),
 *                but an unworked weekend is NOT tallied as missed — most crews
 *                don't work weekends, so a blank weekend never reads as overdue.
 *   - upcoming : a future day in this week (nothing to show yet)
 *
 * The rolling 7-day window the page already fetches always covers this week's
 * Monday→today (the week is at most six days behind today), so no extra fetch
 * is needed.
 */
export type WeekDayState = "logged" | "fix" | "today" | "miss" | "upcoming";

export interface WeekDayCell {
  /** YYYY-MM-DD. */
  date: string;
  /** Short weekday label, e.g. "Mon". */
  weekday: string;
  /** Logged hours for the day, or null when nothing is logged. */
  hours: number | null;
  /** #130: STORED overtime portion of `hours`, or null when the day has none
   *  / nothing logged. Read from the entry — never re-derived. Lets the week
   *  view show a worker the overtime they worked, in worker words. */
  overtimeHours: number | null;
  /** #130: STORED ordinary portion of `hours` (carried alongside overtime so
   *  the split presenter's honesty guard stays meaningful). */
  ordinaryHours: number | null;
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
  /** Worker-facing week tallies — all derived from real entries/calendar. */
  counts: {
    /** Hours on APPROVED entries only (what's locked in). */
    approvedHours: number;
    /** Submitted entries waiting on the office. */
    waiting: number;
    /** Rejected entries the worker must fix. */
    fix: number;
    /** Draft entries logged but never submitted. */
    draft: number;
    /** Past weekdays with no entry at all. */
    missed: number;
  };
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

/** Worker-facing status word for a logged entry. Undefined status (older
 *  callers / partial fixtures) keeps the original plain "logged". */
function loggedStatusWord(status: TimeEntry["status"] | undefined): string {
  switch (status) {
    case "approved":
      return "approved";
    case "submitted":
      return "waiting";
    case "draft":
      return "draft";
    default:
      return "logged";
  }
}

export function buildPhilWeek(
  entries: ReadonlyArray<
    Pick<TimeEntry, "date" | "totalHours"> & {
      status?: TimeEntry["status"];
      ordinaryHours?: number;
      overtimeHours?: number;
    }
  >,
  opts: { todayISO: string },
): PhilWeek {
  const { todayISO } = opts;
  const weekStart = weekStartOf(todayISO);

  // Sum hours per date (defensive against more than one entry on a date) and
  // remember the entry status — one entry per date is API-enforced, so the
  // last status seen for a date is the status. #130: sum the STORED ordinary
  // and overtime portions alongside the total so the week view can show the
  // worker the overtime they worked — never re-derived client-side.
  const hoursByDate = new Map<string, number>();
  const overtimeByDate = new Map<string, number>();
  const ordinaryByDate = new Map<string, number>();
  const statusByDate = new Map<string, TimeEntry["status"] | undefined>();
  for (const e of entries) {
    if (!e.date) continue;
    hoursByDate.set(e.date, (hoursByDate.get(e.date) ?? 0) + (e.totalHours ?? 0));
    overtimeByDate.set(e.date, (overtimeByDate.get(e.date) ?? 0) + (e.overtimeHours ?? 0));
    ordinaryByDate.set(e.date, (ordinaryByDate.get(e.date) ?? 0) + (e.ordinaryHours ?? 0));
    statusByDate.set(e.date, e.status);
  }

  const days: WeekDayCell[] = [];
  let totalHours = 0;
  const counts = { approvedHours: 0, waiting: 0, fix: 0, draft: 0, missed: 0 };

  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const weekday = WEEKDAY_LABELS[i]!;
    const isWeekend = i >= 5; // Sat=5, Sun=6
    const logged = hoursByDate.has(date);
    const hours = logged ? hoursByDate.get(date)! : null;
    const status = statusByDate.get(date);
    if (logged) totalHours += hours!;

    if (status === "approved") counts.approvedHours += hours ?? 0;
    else if (status === "submitted") counts.waiting += 1;
    else if (status === "rejected") counts.fix += 1;
    else if (status === "draft") counts.draft += 1;

    let state: WeekDayState;
    let statusWord: string;
    if (logged && status === "rejected") {
      // The one logged state that needs the worker's hand — never shown as a
      // calm green "logged", even when it's today's entry.
      state = "fix";
      statusWord = "fix";
    } else if (logged && status === "draft") {
      // Logged but never submitted — amber attention, not a calm green tick.
      state = "miss";
      statusWord = "draft";
    } else if (logged) {
      // A real submitted/approved entry reads as DONE → green, INCLUDING today's
      // (so logging a day turns its cell green right away). The "today" cell is
      // only the not-yet-logged prompt below.
      state = "logged";
      statusWord = loggedStatusWord(status);
    } else if (date === todayISO) {
      // Today with nothing logged yet — prompt the log.
      state = "today";
      statusWord = "log now";
    } else if (date > todayISO) {
      // Nothing to act on yet — true of a future weekday or weekend alike.
      state = "upcoming";
      statusWord = "—";
    } else {
      // A PAST day with no entry. Weekends are loggable like weekdays now —
      // the cell invites a tap to log if you worked Sat/Sun — but an unworked
      // weekend is NOT tallied as missed: most crews don't work weekends, so a
      // blank weekend must never flip the week to "needs action".
      state = "miss";
      statusWord = "not logged";
      if (!isWeekend) counts.missed += 1;
    }

    days.push({
      date,
      weekday,
      hours,
      overtimeHours: logged ? (overtimeByDate.get(date) ?? 0) : null,
      ordinaryHours: logged ? (ordinaryByDate.get(date) ?? 0) : null,
      state,
      statusWord,
    });
  }

  return {
    days,
    totalHours,
    todayLogged: hoursByDate.has(todayISO),
    weekStart,
    weekEnd: addDays(weekStart, 6),
    weekNumber: isoWeekNumber(weekStart),
    counts: {
      ...counts,
      approvedHours: Math.round(counts.approvedHours * 100) / 100,
    },
  };
}
