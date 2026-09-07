import type { PatchTimeEntryPayload, TimeEntry } from "@/domains/timesheets/types";
import { weekStartOf, addDays, isWithinBackdateWindow } from "@/domains/timesheets/service";
import { isoWeekNumber } from "./philWeek";

/**
 * Pure logic for the sharpened /phil/hours screen (phil_sharpened, dark —
 * Wave 2c): weeks as collapsible cards, a per-job breakdown, and the
 * "send this week" draft-flush.
 *
 * Honest by construction (P7):
 *   - Weeks are derived ONLY from the worker's real entries (the page already
 *     loads the full history from GET /api/time-entries) plus the calendar's
 *     current week. Nothing is fabricated; a week with no entries simply
 *     isn't rendered (except the current week, which hosts today's logging).
 *   - The per-job breakdown sums REAL allocation hours; job names resolve
 *     from the worker's real assigned jobs, falling back to the allocation's
 *     server-enriched `jobName` (the same rule the day rows use). Only when
 *     neither exists does a row read "A job you're no longer on" — never
 *     guessed; a null-job allocation reads "No job recorded".
 *   - "Send this week to the office" maps onto the REAL submission model:
 *     every Phil logging path already submits at creation (status:
 *     "submitted" — see buildStandardDayPayload et al), so there is no
 *     week-level submit step to fake. The button exists ONLY when the week
 *     truly contains DRAFT entries (legacy / office-created), and it flushes
 *     each one through the existing PATCH /api/time-entries?date= transition
 *     (draft → submitted) — one write per entry, honest per-entry failure.
 *
 * Attribution invariant (the #77/#80/#81 guarantee): a worker with active
 * assigned jobs must never (re)submit hours with jobId: null, and the PATCH
 * path does not re-run the server-side attribution check — the UI is the
 * guardrail (see src/domains/timesheets/resubmit.ts). So a draft is only
 * sendable when every allocation carries a jobId that is one of the worker's
 * ACTIVE assigned jobs; anything else is listed as blocked with the reason.
 */

/** An assigned job as the sharpened screen needs it — id + name (the same
 *  AssignableJob shape the resubmit sheet uses) plus the real job ref for the
 *  code chip (null when the job has none — the chip is honestly absent). */
export interface HoursJobRef {
  id: string;
  name: string;
  ref?: string | null;
}

/** One row of the per-job week breakdown. */
export interface HoursJobBreakdownRow {
  /** null = allocations with no job recorded (legacy/overhead). */
  jobId: string | null;
  /** Real assigned-job name, or an honest fallback label. */
  name: string;
  /** Real job ref for the code chip; null = no chip. */
  ref: string | null;
  /** Summed allocation hours for this job across the week. */
  hours: number;
  /** True when the name came from the worker's real assigned-jobs list. */
  known: boolean;
}

/** The dot on a folded week header — derived from real entry statuses only. */
export type HoursWeekDot = "danger" | "warning" | "info" | "success" | "neutral";

export interface HoursWeek {
  /** Monday, YYYY-MM-DD. */
  weekStart: string;
  /** Sunday, YYYY-MM-DD. */
  weekEnd: string;
  /** ISO-8601 week number. */
  weekNumber: number;
  isCurrent: boolean;
  /** This week's entries, oldest first. */
  entries: TimeEntry[];
  /** Sum of totalHours across the week's entries. */
  totalHours: number;
  /** Sum of the STORED overtimeHours across the week's entries (the pay
   *  truth — never re-derived client-side). 0 for an all-standard week, so
   *  the header renders byte-identical to before (P10: the breakdown line
   *  only exists when there is real overtime to show). */
  overtimeHours: number;
  jobBreakdown: HoursJobBreakdownRow[];
  /** Draft entries that CAN be sent (attribution-safe), oldest first. */
  sendableDrafts: TimeEntry[];
  /** Draft entries that can't be sent from here, with the honest reason. */
  blockedDrafts: Array<{ entry: TimeEntry; reason: string }>;
  dot: HoursWeekDot;
}

/** Week-header dot from the week's real entry statuses (worst-first). */
export function hoursWeekDot(entries: ReadonlyArray<Pick<TimeEntry, "status">>): HoursWeekDot {
  if (entries.some((e) => e.status === "rejected")) return "danger";
  if (entries.some((e) => e.status === "draft")) return "warning";
  if (entries.some((e) => e.status === "submitted")) return "info";
  if (entries.some((e) => e.status === "approved")) return "success";
  return "neutral";
}

/**
 * Is this draft safe to flush to `submitted` from Phil? Mirrors the resubmit
 * guard: jobs must have loaded, and every allocation must carry a jobId that
 * is one of the worker's ACTIVE assigned jobs. `null` = sendable; otherwise
 * the worker-facing reason it's blocked.
 */
export function draftSendBlockReason(
  entry: Pick<TimeEntry, "status" | "allocations">,
  assignedJobs: ReadonlyArray<HoursJobRef>,
  jobsError: boolean
): string | null {
  if (entry.status !== "draft") return "Not a draft";
  if (jobsError) return "Couldn't load your jobs — pull to refresh and try again";
  const allocations = entry.allocations ?? [];
  if (allocations.length === 0) return "No hours recorded on it — ask the office";
  for (const a of allocations) {
    if (!a.jobId) return "No job attached — ask the office to sort it";
    if (!assignedJobs.some((j) => j.id === a.jobId)) {
      return "It's on a job you're no longer assigned to — ask the office";
    }
  }
  return null;
}

/**
 * The exact PATCH payload that flushes a draft to `submitted` — the same
 * rejected/draft → submitted transition the server already supports
 * (api/time-entries.js handlePatch; consumed via timesheetsClient
 * .editOwnEntry). Every field is carried from the REAL entry unchanged;
 * only the status moves.
 */
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

/** Honest fallback names for the breakdown when a job can't be resolved. */
export const UNKNOWN_JOB_LABEL = "A job you're no longer on";
export const NO_JOB_LABEL = "No job recorded";
/** Per-job breakdown across a week's entries — real allocation sums only. */
export function buildJobBreakdown(
  entries: ReadonlyArray<TimeEntry>,
  assignedJobs: ReadonlyArray<HoursJobRef>
): HoursJobBreakdownRow[] {
  const byJob = new Map<string | null, { hours: number; jobName: string | null }>();
  for (const entry of entries) {
    // A day-type day (TAFE / sick / holiday) is not job work — it never
    // rides the per-JOB list (owner-directed 2026-08-10). The day's own row
    // still names its type and its hours still count in the week total;
    // only the job breakdown skips it.
    if (entry.dayType) continue;
    for (const a of entry.allocations ?? []) {
      const key = a.jobId ?? null;
      const agg = byJob.get(key) ?? { hours: 0, jobName: null };
      agg.hours += a.hours ?? 0;
      // Server-enriched allocations carry the real jobName even for jobs the
      // worker is no longer assigned to — reuse it, matching the day rows'
      // rule (allocationLabel: a.jobName ?? UNKNOWN_JOB_LABEL).
      if (!agg.jobName && typeof a.jobName === "string" && a.jobName.trim()) {
        agg.jobName = a.jobName.trim();
      }
      byJob.set(key, agg);
    }
  }
  const rows: HoursJobBreakdownRow[] = [];
  for (const [jobId, { hours, jobName }] of byJob) {
    const job = jobId ? assignedJobs.find((j) => j.id === jobId) : undefined;
    rows.push({
      jobId,
      name: job ? job.name : jobId ? (jobName ?? UNKNOWN_JOB_LABEL) : NO_JOB_LABEL,
      ref: job?.ref ?? null,
      hours: Math.round(hours * 100) / 100,
      known: Boolean(job),
    });
  }
  // Biggest job first; unknown/unattributed rows sink to the bottom.
  rows.sort((a, b) => Number(b.known) - Number(a.known) || b.hours - a.hours);
  return rows;
}

/**
 * Group the worker's real entries into week cards, newest week first.
 *
 * The current week is ALWAYS present (it hosts today's logging even when
 * nothing is logged yet); past weeks appear only when they truly contain
 * entries. `maxWeeks` caps the render (the full history can be years) — the
 * cap is disclosed by the caller, never silently truncated as "all".
 */
export function buildHoursWeeks(
  entries: ReadonlyArray<TimeEntry>,
  opts: {
    todayISO: string;
    assignedJobs: ReadonlyArray<HoursJobRef>;
    jobsError: boolean;
    maxWeeks?: number;
  }
): { weeks: HoursWeek[]; hiddenWeekCount: number } {
  const { todayISO, assignedJobs, jobsError } = opts;
  const maxWeeks = opts.maxWeeks ?? 12;
  const currentMonday = weekStartOf(todayISO);

  const byWeek = new Map<string, TimeEntry[]>();
  for (const entry of entries) {
    if (!entry?.date || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) continue;
    const monday = weekStartOf(entry.date);
    // A future-dated entry ("tomorrow" is within the create window) still
    // belongs to a real week; weeks after the current one are folded into
    // the current card's week only when they ARE the current week. Entries
    // beyond this week are rare — group them under their true week and let
    // the sort place them first.
    const list = byWeek.get(monday);
    if (list) list.push(entry);
    else byWeek.set(monday, [entry]);
  }
  if (!byWeek.has(currentMonday)) byWeek.set(currentMonday, []);
  // The PREVIOUS week is always present too, even when empty (2026-08-10
  // field evidence: a worker who logged nothing last week had no card — and
  // with the day dial scoped to THIS week, the missed-row "Log" pills on a
  // week card were the only path back to those days, so they could neither
  // see nor backfill the week). Every previous-week day is at most 13 days
  // back, always inside the server's 14-day backdate window, so the card's
  // "Not logged" rows never offer a dead pill. Honest by construction (P7):
  // the days truly happened and are truly unlogged. Weeks further back stay
  // entry-only — their days age out of the window and a wall of empty cards
  // would bury the real history (P10).
  const previousMonday = addDays(currentMonday, -7);
  if (!byWeek.has(previousMonday)) byWeek.set(previousMonday, []);

  const mondays = [...byWeek.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const hiddenWeekCount = Math.max(0, mondays.length - maxWeeks);

  const weeks: HoursWeek[] = mondays.slice(0, maxWeeks).map((monday) => {
    const weekEntries = [...(byWeek.get(monday) ?? [])].sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0
    );
    const drafts = weekEntries.filter((e) => e.status === "draft");
    const sendableDrafts: TimeEntry[] = [];
    const blockedDrafts: Array<{ entry: TimeEntry; reason: string }> = [];
    for (const d of drafts) {
      const reason = draftSendBlockReason(d, assignedJobs, jobsError);
      if (reason === null) sendableDrafts.push(d);
      else blockedDrafts.push({ entry: d, reason });
    }
    return {
      weekStart: monday,
      weekEnd: addDays(monday, 6),
      weekNumber: isoWeekNumber(monday),
      isCurrent: monday === currentMonday,
      entries: weekEntries,
      totalHours: Math.round(weekEntries.reduce((s, e) => s + (e.totalHours ?? 0), 0) * 100) / 100,
      overtimeHours:
        Math.round(weekEntries.reduce((s, e) => s + Math.max(0, e.overtimeHours ?? 0), 0) * 100) /
        100,
      jobBreakdown: buildJobBreakdown(weekEntries, assignedJobs),
      sendableDrafts,
      blockedDrafts,
      dot: hoursWeekDot(weekEntries),
    };
  });

  return { weeks, hiddenWeekCount };
}

/** One row of a week card: a real entry, or an honest gap. */
export interface HoursDayRow {
  date: string;
  entry: TimeEntry | null;
  /** Sat/Sun — gap rows carry the "log it if you worked" offer, never the
   *  missing-day "Not logged" (an unworked weekend is not owed). */
  weekend: boolean;
  /** Gap rows only: still inside the server's 14-day backdate window, so the
   *  row may be a live tap target (a dead pill is worse than no pill). */
  loggable: boolean;
}

/**
 * The rows a week card shows, top to bottom — real entries plus honest gaps.
 * Pure and clock-injected (everything keys off `todayISO`, the same value the
 * page passes everywhere), so the rule is unit-testable on fixed dates.
 *
 * Gap rules:
 *   - future days render nothing (nothing to show yet);
 *   - past WEEKDAYS always render — "Not logged" history, tappable while the
 *     backdate window lasts;
 *   - past WEEKEND days render ONLY while still inside the 14-day backdate
 *     window (2026-08-24 field evidence: a worker who worked last Saturday
 *     had no path back to it — the old loop skipped every weekend row and
 *     the log sheet's dial is this-week only; the my-day strip had already
 *     made weekends loggable, philWeek.ts). Out of window they disappear
 *     rather than read as a permanent debt nobody owed.
 */
export function hoursDayRows(
  week: Pick<HoursWeek, "weekStart" | "entries">,
  todayISO: string
): HoursDayRow[] {
  const byDate = new Map(week.entries.map((e) => [e.date, e]));
  const todayRef = new Date(todayISO + "T00:00:00");
  const rows: HoursDayRow[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(week.weekStart, i);
    const entry = byDate.get(date) ?? null;
    const weekend = i >= 5;
    const loggable = isWithinBackdateWindow(date, todayRef) && date <= todayISO;
    if (entry) {
      rows.push({ date, entry, weekend, loggable });
      continue;
    }
    if (date > todayISO) continue; // future — nothing to show yet
    if (weekend && !loggable) continue; // an unworked weekend never reads as owed
    rows.push({ date, entry: null, weekend, loggable });
  }
  return rows;
}

/**
 * Header label for a week card: "This week" / "Last week" / the real Mon–Sun
 * range ("13–19 May" or "30 Jun – 6 Jul"). UTC parsing so the label never
 * drifts a day on non-UTC hosts (same trick as PhilWeekSummary).
 */
export function hoursWeekLabel(weekStart: string, todayISO: string): string {
  const currentMonday = weekStartOf(todayISO);
  if (weekStart === currentMonday) return "This week";
  if (weekStart === addDays(currentMonday, -7)) return "Last week";
  const end = addDays(weekStart, 6);
  const s = new Date(weekStart + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  const day = (d: Date) => d.toLocaleDateString("en-AU", { day: "numeric", timeZone: "UTC" });
  const mon = (d: Date) => d.toLocaleDateString("en-AU", { month: "short", timeZone: "UTC" });
  return s.getUTCMonth() === e.getUTCMonth() && s.getUTCFullYear() === e.getUTCFullYear()
    ? `${day(s)}–${day(e)} ${mon(e)}`
    : `${day(s)} ${mon(s)} – ${day(e)} ${mon(e)}`;
}

/** "Mon 15" — day-row label, UTC-parsed like the rest of the week maths. */
export function hoursDayLabel(dateISO: string, todayISO: string): string {
  const d = new Date(dateISO + "T00:00:00Z");
  const label = d.toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return dateISO === todayISO ? `${label} · Today` : label;
}

/**
 * Fold state for the week cards: the current week open, every past week
 * folded (design §2.6). Pure so the default — and toggling — is testable
 * without a DOM (the repo's vitest runs in the node env).
 */
export function defaultOpenWeeks(
  weeks: ReadonlyArray<Pick<HoursWeek, "weekStart" | "isCurrent">>
): Record<string, boolean> {
  const open: Record<string, boolean> = {};
  for (const w of weeks) open[w.weekStart] = w.isCurrent;
  return open;
}

export function toggleWeek(
  open: Readonly<Record<string, boolean>>,
  weekStart: string
): Record<string, boolean> {
  return { ...open, [weekStart]: !open[weekStart] };
}

/**
 * Optimistic overlay for confirmed saves (2026-07-28). The store's blob
 * listing can lag a fresh write by seconds, so a router.refresh() straight
 * after a save can re-render WITHOUT the day the worker just logged — they
 * watch their submitted hours vanish. Entries the client KNOWS the server
 * accepted (each carries the server's response body, never a guess) are merged
 * over the server list until it catches up: a saved entry wins its date unless
 * the server copy is strictly newer (e.g. the office decided in between).
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
