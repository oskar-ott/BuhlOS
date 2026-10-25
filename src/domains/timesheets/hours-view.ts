import type { PatchTimeEntryPayload, TimeEntry } from "./types";
import {
  MAX_HOURS_PER_DAY,
  STANDARD_DAY_HOURS,
  addDays,
  autoSplitOT,
  isWeekendDate,
  primaryJobId,
  weekStartOf,
} from "./service";
import { formatHoursLabel } from "./format";
import { STATUS_WORDS } from "./status-words";

/**
 * Pure logic for the worker's Hours screen (the 2026-10 "Log my hours"
 * redesign — docs/phil-hours.md). No I/O, no React, clock-injected (every
 * rule keys off `todayISO`), so every rule the screen leans on is pinned by
 * tests in hours-view.test.ts:
 *
 *   - the loggable window: 14 days back, today, tomorrow — nothing else is
 *     ever offered;
 *   - OT maths: a weekday is standard day + OT, capped at 16h (most OT in a
 *     day is 8h 24m); Saturday and Sunday are ALL overtime;
 *   - auto-advance after a save: the next unlogged weekday up to today, never
 *     into a weekend;
 *   - the week summary counts only what's logged — the app does not know
 *     which days anyone works, so there is no "to go" and no "week done";
 *   - job search never returns a leave day (sick / holiday / TAFE are not
 *     jobs and never sit next to jobs).
 *
 * Honest by construction (P7): every row is a real entry or a real calendar
 * day; the only numbers are sums of stored hours.
 */

/** A job the screen can attribute hours to. */
export interface HoursJob {
  id: string;
  name: string;
  ref?: string | null;
  address?: string | null;
  completedAt?: string | null;
  status?: string | null;
}

export type LeaveType = "sick" | "holiday" | "tafe";

/** The one leave vocabulary on this screen — site words, never "leave type". */
export const LEAVE_LABELS: Record<LeaveType, string> = {
  sick: "Sick day",
  holiday: "Holiday",
  tafe: "TAFE day",
};

/** What a leave day means for pay, said before it is sent (P12). */
export const LEAVE_CONSEQUENCE: Record<LeaveType, string> = {
  sick: "This goes to payroll as sick leave, not to a job.",
  holiday: "This goes to payroll as holiday leave, not to a job.",
  tafe: "This goes to payroll as a paid TAFE day, not to a job.",
};

/** The leave options a worker may pick: TAFE for apprentices only. */
export function leaveOptions(canLogTafe: boolean): LeaveType[] {
  return canLogTafe ? ["sick", "holiday", "tafe"] : ["sick", "holiday"];
}

/* ── Dates ────────────────────────────────────────────────────────────── */

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function utc(dateISO: string): Date {
  return new Date(dateISO + "T00:00:00Z");
}

// Fixed tables, not Intl: Node's en-AU says "Sept" where the screen says
// "Sep", and the words must read the same on every phone and in every test.
const WEEKDAYS_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const monthShort = (d: Date) => MONTHS_SHORT[d.getUTCMonth()]!;

/** "Thu 15 Oct" — the one date shape on this screen. */
export function dayDate(dateISO: string): string {
  if (!ISO.test(dateISO)) return dateISO;
  const d = utc(dateISO);
  return `${WEEKDAYS_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${monthShort(d)}`;
}

/** "Thursday" — for button labels that name the whole decision. */
export function weekdayName(dateISO: string): string {
  if (!ISO.test(dateISO)) return dateISO;
  return WEEKDAYS_LONG[utc(dateISO).getUTCDay()]!;
}

/** "Thu" */
export function weekdayShort(dateISO: string): string {
  if (!ISO.test(dateISO)) return dateISO;
  return WEEKDAYS_SHORT[utc(dateISO).getUTCDay()]!;
}

/** "12–18 Oct" or "29 Sep – 5 Oct" for the Mon–Sun week starting `weekStart`. */
export function weekRangeLabel(weekStart: string): string {
  if (!ISO.test(weekStart)) return weekStart;
  const s = utc(weekStart);
  const e = utc(addDays(weekStart, 6));
  return s.getUTCMonth() === e.getUTCMonth()
    ? `${s.getUTCDate()}–${e.getUTCDate()} ${monthShort(e)}`
    : `${s.getUTCDate()} ${monthShort(s)} – ${e.getUTCDate()} ${monthShort(e)}`;
}

/* ── The loggable window ──────────────────────────────────────────────── */

/** How far back a day can be logged from the phone (the server's rule too). */
export const LOG_WINDOW_DAYS_BACK = 14;

/** Oldest day still loggable: today minus 14. */
export function oldestLoggableDate(todayISO: string): string {
  return addDays(todayISO, -LOG_WINDOW_DAYS_BACK);
}

/**
 * Can this day be logged from the phone? 14 days back, today, tomorrow.
 * Mirrors api/_lib/time-entries.js validateEntryShape (diffDays ≤ 14 and
 * ≥ -1) so the screen never offers a day the server will refuse.
 */
export function isLoggableDate(dateISO: string, todayISO: string): boolean {
  if (!ISO.test(dateISO) || !ISO.test(todayISO)) return false;
  return dateISO >= oldestLoggableDate(todayISO) && dateISO <= addDays(todayISO, 1);
}

/* ── Hours maths ──────────────────────────────────────────────────────── */

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Most overtime a weekday can carry: 16h minus the standard day (8h 24m). */
export const MAX_OT_HOURS = round2(MAX_HOURS_PER_DAY - STANDARD_DAY_HOURS);

/** Minutes → decimal hours at the store's 2dp. */
export function hoursFromMinutes(minutes: number): number {
  return round2(Math.max(0, minutes) / 60);
}

/** Decimal hours → whole minutes. */
export function minutesFromHours(hours: number): number {
  return Number.isFinite(hours) && hours > 0 ? Math.round(hours * 60) : 0;
}

/**
 * A weekday's day from its overtime: standard day + OT. Returns the total,
 * and whether it breaks the 16h cap (the caller shows the cap, never sends).
 */
export function weekdayTotalFromOt(otMinutes: number): { totalHours: number; overCap: boolean } {
  const totalHours = round2(STANDARD_DAY_HOURS + hoursFromMinutes(otMinutes));
  return { totalHours, overCap: totalHours > MAX_HOURS_PER_DAY + 1e-9 };
}

/** "7h 36m + 1h OT" / "7h 36m" / "4h OT" (weekend) — from the day's split. */
export function splitLabel(parts: {
  date: string;
  totalHours: number;
  ordinaryHours?: number;
  overtimeHours?: number;
}): string {
  const total = Number(parts.totalHours);
  if (!Number.isFinite(total) || total <= 0) return formatHoursLabel(0);
  const ordinary =
    parts.ordinaryHours !== undefined && parts.overtimeHours !== undefined
      ? Number(parts.ordinaryHours)
      : autoSplitOT(total, parts.date).ordinary;
  const overtime =
    parts.ordinaryHours !== undefined && parts.overtimeHours !== undefined
      ? Number(parts.overtimeHours)
      : autoSplitOT(total, parts.date).overtime;
  // Honesty guard: a stored split that doesn't reconcile shows the total only.
  if (Math.abs(ordinary + overtime - total) > 0.01) return formatHoursLabel(total);
  if (overtime <= 0) return formatHoursLabel(total);
  if (ordinary <= 0) return `${formatHoursLabel(overtime)} OT`;
  return `${formatHoursLabel(ordinary)} + ${formatHoursLabel(overtime)} OT`;
}

/** "+1h OT → 8h 36m total" chip words for a preset add-on in minutes. */
export function otPresetLabel(otMinutes: number): { lead: string; total: string } {
  const h = Math.floor(otMinutes / 60);
  const m = otMinutes % 60;
  const lead =
    h === 0 ? `+${m}m OT` : m === 30 ? `+${h}½h OT` : m === 0 ? `+${h}h OT` : `+${h}h ${m}m OT`;
  return { lead, total: `${formatHoursLabel(weekdayTotalFromOt(otMinutes).totalHours)} total` };
}

/** The four OT presets, in minutes: +30m, +1h, +1½h, +2h. */
export const OT_PRESET_MINUTES = [30, 60, 90, 120] as const;

/* ── Week rows ────────────────────────────────────────────────────────── */

export type DayRowKind =
  | "logged" // a real entry (any status)
  | "pickable" // unlogged, inside the window — Not logged / Today / Tomorrow
  | "future" // beyond tomorrow — "Not yet"
  | "closed"; // unlogged and outside the window (earlier weeks) — read-only

export interface DayRow {
  date: string;
  kind: DayRowKind;
  entry: TimeEntry | null;
  isToday: boolean;
  isTomorrow: boolean;
  weekend: boolean;
}

/** The Mon–Sun rows for the week containing `weekStart`. */
export function weekRows(
  weekStart: string,
  entries: ReadonlyArray<TimeEntry>,
  todayISO: string
): DayRow[] {
  const byDate = new Map(entries.map((e) => [e.date, e]));
  const tomorrow = addDays(todayISO, 1);
  const rows: DayRow[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const entry = byDate.get(date) ?? null;
    const base = {
      date,
      entry,
      isToday: date === todayISO,
      isTomorrow: date === tomorrow,
      weekend: i >= 5,
    };
    if (entry) rows.push({ ...base, kind: "logged" });
    else if (date > tomorrow) rows.push({ ...base, kind: "future" });
    else if (isLoggableDate(date, todayISO)) rows.push({ ...base, kind: "pickable" });
    else rows.push({ ...base, kind: "closed" });
  }
  return rows;
}

/** Entries that fall inside the Mon–Sun week starting `weekStart`. */
export function entriesInWeek(entries: ReadonlyArray<TimeEntry>, weekStart: string): TimeEntry[] {
  const end = addDays(weekStart, 6);
  return entries.filter((e) => ISO.test(e.date) && e.date >= weekStart && e.date <= end);
}

/**
 * The summary line: counts ONLY what's logged. "3 days logged · 23h 48m" or
 * "Nothing logged yet this week". Never "of N", never "to go".
 */
export function weekSummaryLine(weekEntries: ReadonlyArray<TimeEntry>): string {
  if (weekEntries.length === 0) return "Nothing logged yet this week";
  const total = round2(weekEntries.reduce((s, e) => s + (Number(e.totalHours) || 0), 0));
  const n = weekEntries.length;
  return `${n} ${n === 1 ? "day" : "days"} logged · ${formatHoursLabel(total)}`;
}

/** "1 day needs fixing · Tue" / "2 days need fixing · Tue, Thu" / null. */
export function fixNeededLine(weekEntries: ReadonlyArray<TimeEntry>): string | null {
  const fix = weekEntries
    .filter((e) => e.status === "rejected")
    .sort((a, b) => a.date.localeCompare(b.date));
  if (fix.length === 0) return null;
  const days = fix.map((e) => weekdayShort(e.date)).join(", ");
  return fix.length === 1
    ? `1 day needs fixing · ${days}`
    : `${fix.length} days need fixing · ${days}`;
}

/* ── Picking and auto-advance ─────────────────────────────────────────── */

/**
 * The day to pick when the screen opens: the earliest unlogged WEEKDAY of
 * this week up to today (an end-of-week catch-up starts on Monday); else
 * today if it is unlogged and loggable (a Saturday the worker opens the app
 * on); else none — the panel then says there's nothing waiting.
 */
export function initialPick(entries: ReadonlyArray<TimeEntry>, todayISO: string): string | null {
  const logged = new Set(entries.map((e) => e.date));
  const monday = weekStartOf(todayISO);
  for (let i = 0; i < 5; i++) {
    const date = addDays(monday, i);
    if (date > todayISO) break;
    if (!logged.has(date) && isLoggableDate(date, todayISO)) return date;
  }
  if (!logged.has(todayISO) && isLoggableDate(todayISO, todayISO)) return todayISO;
  return null;
}

/**
 * After a save, where the pick moves: the next unlogged WEEKDAY of this week
 * after `savedDate`, up to today. Never a weekend, never tomorrow, never an
 * earlier week. Null when there is none (the Saved panel stays).
 */
export function nextPickAfterSave(
  savedDate: string,
  entries: ReadonlyArray<TimeEntry>,
  todayISO: string
): string | null {
  const logged = new Set(entries.map((e) => e.date));
  logged.add(savedDate);
  const monday = weekStartOf(todayISO);
  // Resume from the saved day when it's in this week, else from Monday.
  const from = savedDate >= monday && savedDate <= todayISO ? addDays(savedDate, 1) : monday;
  for (let date = from; date <= todayISO; date = addDays(date, 1)) {
    if (isWeekendDate(date)) continue;
    if (date > addDays(monday, 6)) break;
    if (!logged.has(date) && isLoggableDate(date, todayISO)) return date;
  }
  // Nothing after it — a day skipped earlier in the week still counts.
  for (let i = 0; i < 5; i++) {
    const date = addDays(monday, i);
    if (date > todayISO) break;
    if (!logged.has(date) && isLoggableDate(date, todayISO)) return date;
  }
  return null;
}

/* ── Jobs ─────────────────────────────────────────────────────────────── */

/**
 * Which job the panel opens on for a day: an explicit pick for that day,
 * else the worker's last logged job (when still assignable), else the sole
 * assigned job, else nothing — a worker on several jobs who has never logged
 * one picks explicitly. Pure so the "no default" state is testable.
 */
export function defaultJobId(input: {
  picked: string | null | undefined;
  lastJobId: string | null;
  jobs: ReadonlyArray<HoursJob>;
}): string | null {
  if (input.picked && input.jobs.some((j) => j.id === input.picked)) return input.picked;
  if (input.lastJobId && input.jobs.some((j) => j.id === input.lastJobId)) return input.lastJobId;
  if (input.jobs.length === 1) return input.jobs[0]!.id;
  return null;
}

/** Jobs matching a query by name, code or address. Leave days are not jobs
 *  and are never in the input, so they can never be in the output. */
export function searchJobs<J extends HoursJob>(jobs: ReadonlyArray<J>, query: string): J[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...jobs];
  return jobs.filter((j) =>
    [j.name, j.ref, j.address].some((f) => typeof f === "string" && f.toLowerCase().includes(q))
  );
}

/** A finished / closed job (the field's callback case). */
export function isFinishedJob(job: Pick<HoursJob, "completedAt" | "status">): boolean {
  return Boolean(job.completedAt) || job.status === "complete" || job.status === "closed";
}

/** "Logged Tue 13 Oct" — the last day the worker logged this job, or null. */
export function lastLoggedDateForJob(
  entries: ReadonlyArray<Pick<TimeEntry, "date" | "allocations">>,
  jobId: string
): string | null {
  let best: string | null = null;
  for (const e of entries) {
    if ((e.allocations ?? []).some((a) => a.jobId === jobId) && (!best || e.date > best))
      best = e.date;
  }
  return best;
}

/* ── Receipts ─────────────────────────────────────────────────────────── */

/** What an entry was booked to, in the worker's words: the leave type, else
 *  the job name(s). A job the screen can't name reads honestly. */
export function entryTarget(
  entry: Pick<TimeEntry, "dayType" | "allocations">,
  jobs: ReadonlyArray<HoursJob>
): string {
  if (entry.dayType && LEAVE_LABELS[entry.dayType as LeaveType]) {
    return LEAVE_LABELS[entry.dayType as LeaveType];
  }
  const names = (entry.allocations ?? []).map((a) => {
    const job = a.jobId ? jobs.find((j) => j.id === a.jobId) : undefined;
    if (job) return job.name;
    if (a.jobId) return a.jobName?.trim() || "A job you're no longer on";
    return "No job recorded";
  });
  return names.length > 0 ? [...new Set(names)].join(" + ") : "No job recorded";
}

/** "Thu 15 Oct · Bondi switchboard · 7h 36m + 1h OT" — the receipt words
 *  the week row, the Saved panel and every review line share. */
export function receiptLine(
  entry: Pick<
    TimeEntry,
    "date" | "dayType" | "allocations" | "totalHours" | "ordinaryHours" | "overtimeHours"
  >,
  jobs: ReadonlyArray<HoursJob>
): string {
  const split = (entry.allocations ?? []).length > 1;
  const hours = split
    ? (entry.allocations ?? [])
        .map((a) => {
          const job = a.jobId ? jobs.find((j) => j.id === a.jobId) : undefined;
          const name = job?.name ?? a.jobName?.trim() ?? "A job you're no longer on";
          return `${name} ${formatHoursLabel(a.hours)}`;
        })
        .join(" + ") + ` · ${formatHoursLabel(entry.totalHours)} total`
    : `${entryTarget(entry, jobs)} · ${splitLabel(entry)}`;
  return `${dayDate(entry.date)} · ${hours}`;
}

/** The worker's status word for an entry. */
export function statusWordFor(entry: Pick<TimeEntry, "status">): string {
  return STATUS_WORDS[entry.status];
}

/* ── Earlier weeks ────────────────────────────────────────────────────── */

/** How many folded earlier weeks the screen shows — the page reads back
 *  exactly this far; older days are the office's. */
export const EARLIER_WEEKS_SHOWN = 12;

export interface EarlierWeek {
  weekStart: string;
  /** "5–11 Oct" */
  range: string;
  entries: TimeEntry[];
  totalHours: number;
  /** "4 days · all approved" / "3 days · 1 fix needed" / "No days logged" */
  line: string;
  /** True when at least one day in it can still be logged. */
  hasLoggableDays: boolean;
}

/**
 * Weeks before this one, newest first: every week that holds an entry, plus
 * the week(s) still inside the 14-day window even when empty (their days can
 * still be logged — the worker needs a way back to them). Capped by
 * `maxWeeks`; the cap is disclosed by the caller.
 */
export function buildEarlierWeeks(
  entries: ReadonlyArray<TimeEntry>,
  todayISO: string,
  maxWeeks = EARLIER_WEEKS_SHOWN
): { weeks: EarlierWeek[]; hidden: number } {
  const currentMonday = weekStartOf(todayISO);
  const mondays = new Set<string>();
  for (const e of entries) {
    if (!ISO.test(e.date)) continue;
    const m = weekStartOf(e.date);
    if (m < currentMonday) mondays.add(m);
  }
  // Weeks inside the window are always present (their days are offered).
  for (let m = weekStartOf(oldestLoggableDate(todayISO)); m < currentMonday; m = addDays(m, 7)) {
    mondays.add(m);
  }
  const sorted = [...mondays].sort((a, b) => b.localeCompare(a));
  const hidden = Math.max(0, sorted.length - maxWeeks);
  const weeks = sorted.slice(0, maxWeeks).map((weekStart): EarlierWeek => {
    const weekEntries = entriesInWeek(entries, weekStart).sort((a, b) =>
      a.date.localeCompare(b.date)
    );
    const totalHours = round2(weekEntries.reduce((s, e) => s + (Number(e.totalHours) || 0), 0));
    const rows = weekRows(weekStart, weekEntries, todayISO);
    return {
      weekStart,
      range: weekRangeLabel(weekStart),
      entries: weekEntries,
      totalHours,
      line: earlierWeekLine(weekEntries),
      hasLoggableDays: rows.some((r) => r.kind === "pickable"),
    };
  });
  return { weeks, hidden };
}

function earlierWeekLine(weekEntries: ReadonlyArray<TimeEntry>): string {
  if (weekEntries.length === 0) return "No days logged";
  const n = weekEntries.length;
  const days = `${n} ${n === 1 ? "day" : "days"}`;
  const fix = weekEntries.filter((e) => e.status === "rejected").length;
  if (fix > 0) return `${days} · ${fix} fix needed`;
  const waiting = weekEntries.filter((e) => e.status === "submitted").length;
  const notSent = weekEntries.filter((e) => e.status === "draft").length;
  if (waiting === 0 && notSent === 0) return `${days} · all approved`;
  const parts: string[] = [];
  if (waiting > 0) parts.push(`${waiting} waiting on the office`);
  if (notSent > 0) parts.push(`${notSent} not sent`);
  return `${days} · ${parts.join(" · ")}`;
}

/* ── Saved-entry overlay ──────────────────────────────────────────────── */

/**
 * Overlay for confirmed saves: the store's listing can lag a fresh write by
 * seconds, so a refresh straight after a save can re-render WITHOUT the day
 * the worker just logged. Entries the client KNOWS the server accepted (each
 * is the server's own response body) win their date unless the server copy is
 * strictly newer (the office decided in between).
 */
export function mergeSavedEntries(
  serverEntries: ReadonlyArray<TimeEntry>,
  savedEntries: ReadonlyArray<TimeEntry>
): ReadonlyArray<TimeEntry> {
  if (savedEntries.length === 0) return serverEntries;
  const byDate = new Map<string, TimeEntry>();
  for (const e of serverEntries) byDate.set(e.date, e);
  for (const saved of savedEntries) {
    const server = byDate.get(saved.date);
    if (!server || String(saved.updatedAt ?? "") >= String(server.updatedAt ?? "")) {
      byDate.set(saved.date, saved);
    }
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/* ── Office drafts ("Not sent") ───────────────────────────────────────── */

/**
 * Can this office-created draft be sent from the phone? Jobs must have
 * loaded and every allocation must carry one of the worker's assigned jobs
 * (a field self-edit may never attribute hours to no job). `null` = sendable;
 * otherwise the reason, in the worker's words.
 */
export function draftSendBlockReason(
  entry: Pick<TimeEntry, "status" | "allocations" | "dayType">,
  jobs: ReadonlyArray<HoursJob>,
  jobsError: boolean
): string | null {
  if (entry.status !== "draft") return "This day isn't a draft";
  if (entry.dayType) return null; // leave days carry no job by design
  if (jobsError) return "Couldn't load your jobs — pull to refresh and try again";
  const allocations = entry.allocations ?? [];
  if (allocations.length === 0) return "No hours recorded on it — ask the office";
  for (const a of allocations) {
    if (!a.jobId) return "No job attached — ask the office to sort it";
    if (!jobs.some((j) => j.id === a.jobId))
      return "It's on a job you're no longer assigned to — ask the office";
  }
  return null;
}

/** The PATCH that sends a draft as-is: every field carried, only the status moves. */
export function buildDraftSendPayload(entry: TimeEntry): PatchTimeEntryPayload {
  return {
    date: entry.date,
    totalHours: entry.totalHours,
    ordinaryHours: entry.ordinaryHours,
    overtimeHours: entry.overtimeHours,
    allocations: (entry.allocations ?? []).map((a) => ({
      jobId: a.jobId,
      hours: a.hours,
      notes: a.notes ?? null,
    })),
    notes: entry.notes ?? null,
    status: "submitted",
  };
}

/** The job a single-job entry was sent on, or null. */
export { primaryJobId };
