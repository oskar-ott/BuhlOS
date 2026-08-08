import type {
  WeeklyHoursCloseout,
  WeeklyHoursDay,
  WeeklyWorkerHours,
  WeeklyDayStatus,
} from "./weekly-closeout";

/**
 * Pay-run view-model (brief §5) — the weekly pay-run approval as the office's
 * one ritual: a payday hero that answers "how far through this week's run am
 * I?", and a seven-day strip per worker so the SHAPE of each week reads at a
 * glance before you expand a single row.
 *
 * Pure + deterministic, so it is unit-tested in isolation. It is a PROJECTION
 * over the existing `buildWeeklyHoursCloseout` model — no new endpoint, no new
 * storage, no second status-transition path. The interactive board still owns
 * the (permission-gated) approve / reject / reopen mutations; this only shapes
 * what the operator sees.
 *
 * HONESTY (the project's #1 law — no fake UI, no invented numbers):
 *   - MONEY ON, HONESTLY. /hours is admin-tier, so the §5 mockup's labour $ is
 *     correct to show here. The page reads the confidential, effective-dated
 *     cost rate (api/cost-rates.js — admin-gated) and the closeout multiplies
 *     LOGGED hours × the rate effective on the week's Monday. A worker with NO
 *     rate carries `labourCents: null` and renders "—" — never a fabricated $0
 *     — and the hero omits the labour figure entirely when NO worker is rated
 *     (no column of dashes). A leading-hand viewer never gets rates (the page
 *     passes none), so the same "—"/omit path keeps cost off their screen.
 *   - "Approve all clean" only counts weeks that are ACTIONABLE RIGHT NOW: a
 *     worker whose ONLY open state is `submitted` days (no rejected, no draft,
 *     no missing). A flagged week (anything else outstanding) is never swept
 *     into a bulk approve — it needs a human look first. An empty pay run has
 *     zero clean weeks, never a fabricated "all done".
 *   - The strip status is read straight off the closeout day cells — it never
 *     re-derives missing/leave/holiday (those come from the server).
 */

/** The five glanceable strip tones — a superset reduction of the nine day
 *  statuses into what the office scans for. */
export type StripTone =
  | "approved"
  | "submitted"
  | "rejected"
  | "draft"
  | "missing"
  | "leave"
  | "holiday"
  | "empty";

export interface StripCell {
  /** YYYY-MM-DD. */
  date: string;
  /** "Mon" … "Sun". */
  weekday: string;
  /** Underlying closeout status (load-bearing for the title/legend). */
  status: WeeklyDayStatus;
  /** Reduced tone for the strip square. */
  tone: StripTone;
  /** Pre-formatted hours for the cell ("7h 36m"), or null when no entry. */
  hoursLabel: string | null;
  /** §5 mockup: the RAW logged-hours number for the dense day cell — "8",
   *  "8.5", "10.5" — or null when the day has no logged hours (then the cell
   *  shows `emptyGlyph`, never a fabricated 0). Decimal hours, ≤2 dp. */
  hoursNumber: number | null;
  /** Compact decimal form of `hoursNumber` for the dense strip ("8", "8.5"),
   *  or null. Pre-formatted so the presenter stays string-only. */
  hoursShort: string | null;
  /** Glyph the strip shows when there are no hours: "—" missing, "·" off/
   *  future/not-required, "" otherwise. Never a fake number. */
  emptyGlyph: string;
  /** Full hover/aria text, e.g. "Wed 22 · Submitted · 7h 36m · 100 Arthur". */
  title: string;
}

export interface PayRunHero {
  /** "Mon 20 May – Sun 26 May". */
  rangeLabel: string;
  /** Workers in the run (have an entry or a server-flagged missing day). */
  crewCount: number;
  /** Workers already payroll-ready (every day settled). */
  readyCount: number;
  /** Workers with anything outstanding. */
  needActionCount: number;
  /** Workers flagged for a look — outstanding state that is NOT just
   *  pending-approval (rejected / draft / missing). */
  flaggedCount: number;
  /** Approved hours across the run, pre-formatted ("142h 30m"). */
  approvedHoursLabel: string;
  /** §5 hero "{totalHrs}h logged" — LOGGED hours across the run as a compact
   *  number string ("412", "412.5"). The figure the day-number strip adds to. */
  loggedHoursShort: string;
  /** §5 hero "${labour} labour" — total labour across rated workers, as a
   *  rounded whole-dollar string with thousands separators ("$24,180"), or null
   *  when NO worker in the run has a cost rate (the hero omits the figure). */
  labourLabel: string | null;
  /** Submitted (awaiting-approval) day count across the run. */
  submittedDays: number;
  /** §5 hero "{needLook} need a look" — workers flagged for a human look. */
  needLookCount: number;
  /** Progress 0..100 = readyCount / crewCount, rounded; 0 for an empty run. */
  progressPct: number;
  /** True only when there is a crew AND every worker is payroll-ready. */
  allReady: boolean;
}

export interface PayRunVM {
  hero: PayRunHero;
  /** {userId, date} pairs for every CLEAN week's submitted days — the body for
   *  one "Approve all clean" bulk call. Empty when nothing is sweepable. */
  cleanApproval: ReadonlyArray<{ userId: string; date: string }>;
  /** Distinct clean workers behind cleanApproval (for the button count/label). */
  cleanWorkerCount: number;
}

const STRIP_TONE: Record<WeeklyDayStatus, StripTone> = {
  approved: "approved",
  submitted: "submitted",
  rejected: "rejected",
  draft: "draft",
  missing: "missing",
  // Mid-week un-logged day (weekly logging rhythm) — calm, not a red cell.
  pending: "empty",
  leave: "leave",
  holiday: "holiday",
  future: "empty",
  "not-required": "empty",
};

/** A worker is "flagged for a look" when something is outstanding that is not
 *  simply waiting on an approver — i.e. the office can't just rubber-stamp it. */
export function isFlaggedWeek(worker: WeeklyWorkerHours): boolean {
  // pendingCount: an un-ended week with un-logged days is never "clean" —
  // the calm mid-week tone must not let a half-logged week get swept/locked.
  return (
    worker.rejectedCount > 0 ||
    worker.draftCount > 0 ||
    worker.missingCount > 0 ||
    worker.pendingCount > 0
  );
}

/** A "clean" week: ready to approve in one tap — at least one submitted day and
 *  NOTHING else outstanding (no rejected / draft / missing). Approved-only and
 *  empty weeks are not "clean to approve" (nothing to do). */
export function isCleanWeek(worker: WeeklyWorkerHours): boolean {
  return worker.submittedCount > 0 && !isFlaggedWeek(worker);
}

/** "Mon 20 May" — strip-cell / range label, UTC-parsed like the board. */
function shortDayLabel(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return new Date(date + "T00:00:00Z").toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** Hours label for a strip cell — `null` when the day has no logged hours so
 *  the cell shows a glyph, never a fabricated 0. */
function cellHoursLabel(hours: number | null): string | null {
  if (hours == null || !(hours > 0)) return null;
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes - h * 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

/** §5 dense day number — "8", "8.5", "10.5". `null` when no logged hours so the
 *  cell shows a glyph, never a fabricated 0. Trims trailing zeros to ≤2 dp. */
export function shortHours(hours: number | null): string | null {
  if (hours == null || !(hours > 0)) return null;
  return String(Math.round(hours * 100) / 100);
}

/** §5 whole-dollar label from integer cents — "$24,180" (en-AU thousands).
 *  Pure; null/sub-zero in → null so callers can omit rather than print "$0". */
export function wholeDollarsFromCents(cents: number | null | undefined): string | null {
  if (cents == null || !Number.isFinite(cents) || cents <= 0) return null;
  return `$${Math.round(cents / 100).toLocaleString("en-AU")}`;
}

const STATUS_WORD: Record<WeeklyDayStatus, string> = {
  approved: "Approved",
  submitted: "Submitted",
  rejected: "Rejected",
  draft: "Draft — not submitted",
  missing: "Missing",
  pending: "Not logged yet",
  leave: "On leave",
  holiday: "Public holiday",
  future: "Upcoming",
  "not-required": "No hours",
};

/** Build one strip cell from a closeout day. */
export function toStripCell(day: WeeklyHoursDay): StripCell {
  const tone = STRIP_TONE[day.status];
  const hoursLabel = cellHoursLabel(day.hours);
  const emptyGlyph =
    hoursLabel != null
      ? ""
      : day.status === "missing"
        ? "—"
        : day.status === "leave"
          ? "L"
          : day.status === "holiday"
            ? "H"
            : "·";

  const parts: string[] = [shortDayLabel(day.date), STATUS_WORD[day.status]];
  if (hoursLabel) parts.push(hoursLabel);
  if (day.status === "leave" && day.leaveType) parts.push(day.leaveType);
  if (day.status === "holiday" && day.holidayName) parts.push(day.holidayName);
  if (day.jobLabel) parts.push(day.jobLabel);

  return {
    date: day.date,
    weekday: day.weekday,
    status: day.status,
    tone,
    hoursLabel,
    hoursNumber: day.hours != null && day.hours > 0 ? day.hours : null,
    hoursShort: shortHours(day.hours),
    emptyGlyph,
    title: parts.join(" · "),
  };
}

/** The seven strip cells for a worker's week (Mon → Sun), in order. */
export function workerStrip(worker: WeeklyWorkerHours): StripCell[] {
  return worker.days.map(toStripCell);
}

/** Cap on a single bulk-approve call — mirrors the endpoint's MAX_ENTRIES
 *  (api/time-entries-bulk-approve.js) so the body is never over-long. */
export const PAY_RUN_BULK_MAX = 50;

/**
 * Project the weekly closeout into the pay-run hero + the clean-sweep
 * selection. Pure: same closeout in → same VM out.
 */
export function buildPayRun(closeout: WeeklyHoursCloseout): PayRunVM {
  const { workers, summary } = closeout;
  const crewCount = workers.length;
  const readyCount = summary.workersReady;
  const flaggedCount = workers.filter(isFlaggedWeek).length;

  const progressPct =
    crewCount > 0 ? Math.round((readyCount / crewCount) * 100) : 0;

  const hero: PayRunHero = {
    rangeLabel: `${shortDayLabel(closeout.weekStart)} – ${shortDayLabel(closeout.weekEnd)}`,
    crewCount,
    readyCount,
    needActionCount: summary.workersNeedAction,
    flaggedCount,
    approvedHoursLabel: cellHoursLabel(summary.approvedHours) ?? "0h",
    loggedHoursShort: shortHours(summary.loggedHours) ?? "0",
    // Only show a labour figure when at least one worker is rated — otherwise
    // omit it (no "$0" lie, no column of dashes). §5 + honesty rules.
    labourLabel:
      summary.ratedWorkers > 0 ? wholeDollarsFromCents(summary.labourCents) : null,
    submittedDays: summary.submittedDays,
    needLookCount: flaggedCount,
    progressPct,
    allReady: crewCount > 0 && readyCount === crewCount,
  };

  // Clean sweep: every submitted day of every clean week, capped at the
  // endpoint maximum. Flagged weeks (rejected/draft/missing) are excluded —
  // they need a human look, never a bulk rubber-stamp.
  const cleanWorkers = workers.filter(isCleanWeek);
  const cleanApproval: Array<{ userId: string; date: string }> = [];
  for (const w of cleanWorkers) {
    for (const d of w.days) {
      if (d.status === "submitted") {
        cleanApproval.push({ userId: w.workerId, date: d.date });
      }
    }
  }

  return {
    hero,
    cleanApproval: cleanApproval.slice(0, PAY_RUN_BULK_MAX),
    cleanWorkerCount: cleanWorkers.length,
  };
}
