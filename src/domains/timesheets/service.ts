import type { MissingLog, TimeEntry, TimeEntryAllocation, TimeEntryStatus } from "./types";

/**
 * Pure helpers for the timesheets domain. No I/O, no React, no globals —
 * everything here is unit-testable in isolation.
 *
 * Cross-ref: docs/rebuild-audit/19-phase-b-hours-implementation-brief.md
 *            §"Data model requirements"
 */

/**
 * The "Standard day" used by the one-tap Standard Day button in Phil.
 *
 * 7 hours 36 minutes = 7.6 decimal hours = 456 minutes.
 *
 * This is the contractual day length per [[project_buhlos_phil_hours_pipeline]]
 * and the Phase B brief §Phil surface.
 */
export const STANDARD_DAY_HOURS = 7.6;
export const STANDARD_DAY_MINUTES = 456;

/**
 * The maximum number of hours that can be logged in a single day. Mirrors the
 * Phase B brief §validation. The legacy server has no upper bound by default,
 * so this is enforced client-side before submission to prevent obvious typos.
 */
export const MAX_HOURS_PER_DAY = 16;

/**
 * The maximum number of days backwards a worker can log hours for. Mirrors
 * the legacy server's backdating limit (`validateEntryShape` in
 * api/_lib/time-entries.js refuses entries older than 14 days).
 */
export const MAX_BACKDATE_DAYS = 14;

/**
 * The business timezone. Used **only** when the worker's browser/local
 * timezone isn't available — e.g. server components computing "today" for
 * a query against the API. Client-facing code (the form input, the
 * isWithinBackdateWindow check that runs in the browser) should default to
 * the worker's local timezone instead, so the date the worker sees matches
 * what their phone clock says.
 *
 * BuhlOS is a Sydney/NSW electrical contractor today; if the org expands
 * across timezones this becomes a per-organisation setting.
 */
export const BUSINESS_TIMEZONE = "Australia/Sydney" as const;

/**
 * Auto-split a total into ordinary (first 8) and overtime (excess).
 * Matches `autoSplitOT` in api/_lib/time-entries.js exactly so client +
 * server agree.
 */
export function autoSplitOT(totalHours: number): { ordinary: number; overtime: number } {
  const ordinary = Math.min(totalHours, 8);
  const overtime = Math.max(0, totalHours - 8);
  return {
    ordinary: Math.round(ordinary * 100) / 100,
    overtime: Math.round(overtime * 100) / 100,
  };
}

/**
 * Decimal hours → the hours + minutes a duration input edits.
 *
 * Site dialect is durations, never decimals: a worker typed "8.36" meaning
 * 8h 36m and the decimal field read it as 8h 22m, which is the bug this whole
 * amend capability exists to fix. Every hours input is an h field and an m
 * field; these two helpers are the only conversion between that pair and the
 * decimal the store speaks, so no screen re-invents the rounding.
 *
 * Minutes round to the nearest whole minute and carry into the hour (7.999h →
 * 8h 0m), so the pair is always a legal clock reading.
 */
export function splitHoursMinutes(decimalHours: number): { hours: number; minutes: number } {
  if (!Number.isFinite(decimalHours) || decimalHours <= 0) return { hours: 0, minutes: 0 };
  const totalMinutes = Math.round(decimalHours * 60);
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

/** Hours + minutes → decimal hours, rounded to the store's 2dp. */
export function hoursFromHm(hours: number, minutes: number): number {
  const h = Number.isFinite(hours) ? Math.max(0, Math.floor(hours)) : 0;
  const m = Number.isFinite(minutes) ? Math.max(0, Math.floor(minutes)) : 0;
  return Math.round((h * 60 + m) * (100 / 60)) / 100;
}

/**
 * True if the allocations array sums to the total (within rounding tolerance).
 * Used as a final sanity check before submit.
 */
export function allocationsSumValid(
  total: number,
  allocations: ReadonlyArray<{ hours: number }>
): boolean {
  const sum = allocations.reduce((s, a) => s + a.hours, 0);
  return Math.abs(sum - total) <= 0.01;
}

/**
 * True if the worker can transition the entry to `submitted`. Mirrors the
 * legacy server's gating: draft and rejected can be (re-)submitted; submitted
 * and approved cannot.
 */
export function canSubmit(status: TimeEntryStatus): boolean {
  return status === "draft" || status === "rejected";
}

/**
 * True if the entry is editable by the worker. Approved entries are locked
 * behind admin reopen.
 *
 * 2026-07-26 owner-directed: a `submitted` (undecided) day is editable too —
 * the worker can fix a sent day until the office decides. Mirrors the server
 * (api/time-entries.js handlePatch), which has always allowed the owner to
 * content-edit a submitted entry; only approved/exported are admin-locked.
 */
export function canEdit(status: TimeEntryStatus): boolean {
  return status === "draft" || status === "rejected" || status === "submitted";
}

/**
 * True if an admin / leading hand can act on the entry from the approval
 * queue. The legacy server gates approve/reject on `status === 'submitted'`.
 */
export function canApprove(status: TimeEntryStatus): boolean {
  return status === "submitted";
}

/**
 * Returns the date string YYYY-MM-DD for the supplied Date instance.
 *
 * When `timeZone` is omitted (the default), the result is the calendar date
 * in the runtime's local timezone — on the client that is the worker's
 * browser timezone (their phone clock), on the server that is whatever the
 * server box reports (typically UTC on Vercel). Callers in server
 * components that need "today in the business" should pass
 * `BUSINESS_TIMEZONE` explicitly so a Vercel-UTC server doesn't compute
 * yesterday's date for a Sydney worker.
 *
 * The legacy server validates the date string and treats it as a calendar
 * day (no time component), so we must always send the worker's *local* day —
 * not UTC midnight, which can resolve to the previous day.
 */
export function localDateString(d: Date = new Date(), timeZone?: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA formats as YYYY-MM-DD natively
  return fmt.format(d);
}

/**
 * Returns the ISO week-start (Monday) date string YYYY-MM-DD for the day
 * containing `date`. Used by the admin weekly approval rollup view.
 *
 * Implementation note: we use UTC arithmetic on a UTC-midnight Date so that
 * the result is timezone-independent — the input string is already a
 * calendar date with no time component.
 */
export function weekStartOf(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const d = new Date(date + "T00:00:00Z");
  const day = d.getUTCDay(); // 0 Sunday … 6 Saturday
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day2 = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day2}`;
}

/**
 * Returns the ISO week-end (Sunday) date string YYYY-MM-DD for the day
 * containing `date` — i.e. weekStartOf(date) + 6 days. Used by the admin
 * weekly overview to bound a Mon..Sun range.
 */
export function weekEndOf(date: string): string {
  const monday = weekStartOf(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(monday)) return date;
  return addDays(monday, 6);
}

/**
 * Shift a YYYY-MM-DD date string by `n` calendar days (negative shifts
 * backwards). Timezone-independent: the input is a bare calendar date, so we
 * do UTC-midnight arithmetic and never cross a DST boundary by accident.
 * Used by the weekly view's prev/next-week navigation.
 */
export function addDays(date: string, n: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Build a CreateTimeEntryPayload that submits a Standard Day for a single
 * job. The default flow on Phil's My Day uses this directly.
 */
export function buildStandardDayPayload(input: {
  date: string;
  jobId: string | null;
  notes?: string | null;
}): {
  date: string;
  totalHours: number;
  ordinaryHours: number;
  overtimeHours: number;
  allocations: Array<{ jobId: string | null; hours: number; notes: null }>;
  status: "submitted";
  notes: string | null;
} {
  const { ordinary, overtime } = autoSplitOT(STANDARD_DAY_HOURS);
  return {
    date: input.date,
    totalHours: STANDARD_DAY_HOURS,
    ordinaryHours: ordinary,
    overtimeHours: overtime,
    allocations: [
      {
        jobId: input.jobId,
        hours: STANDARD_DAY_HOURS,
        notes: null,
      },
    ],
    status: "submitted",
    notes: input.notes ?? null,
  };
}

/**
 * Build a CreateTimeEntryPayload for custom hours against a single job.
 * Multi-job allocation is a Phase B nice-to-have; the MVP UI submits one job
 * at a time. The schema allows multiple allocations whenever the UI is ready.
 */
export function buildCustomHoursPayload(input: {
  date: string;
  totalHours: number;
  jobId: string | null;
  notes?: string | null;
}): {
  date: string;
  totalHours: number;
  ordinaryHours: number;
  overtimeHours: number;
  allocations: Array<{ jobId: string | null; hours: number; notes: null }>;
  status: "submitted";
  notes: string | null;
} {
  const { ordinary, overtime } = autoSplitOT(input.totalHours);
  return {
    date: input.date,
    totalHours: input.totalHours,
    ordinaryHours: ordinary,
    overtimeHours: overtime,
    allocations: [{ jobId: input.jobId, hours: input.totalHours, notes: null }],
    status: "submitted",
    notes: input.notes ?? null,
  };
}

/**
 * Build a CreateTimeEntryPayload that SPLITS the day across 2+ jobs (#128).
 * One entry, multiple allocations summing to the total — the model and the
 * server have always supported this; this is the Phil-side builder. OT is
 * split on the day TOTAL (overtime is a property of the day, not a job).
 * Pure: validation (every jobId picked, hours > 0, sum = total ±0.01) is the
 * caller's; this only assembles the shape the API + the single-job builders
 * already use.
 */
export function buildSplitDayPayload(input: {
  date: string;
  totalHours: number;
  allocations: ReadonlyArray<{ jobId: string | null; hours: number }>;
  notes?: string | null;
}): {
  date: string;
  totalHours: number;
  ordinaryHours: number;
  overtimeHours: number;
  allocations: Array<{ jobId: string | null; hours: number; notes: null }>;
  status: "submitted";
  notes: string | null;
} {
  const { ordinary, overtime } = autoSplitOT(input.totalHours);
  return {
    date: input.date,
    totalHours: input.totalHours,
    ordinaryHours: ordinary,
    overtimeHours: overtime,
    allocations: input.allocations.map((a) => ({
      jobId: a.jobId,
      hours: a.hours,
      notes: null,
    })),
    status: "submitted",
    notes: input.notes ?? null,
  };
}

/**
 * The remainder for the LAST split row, so the worker never does subtraction:
 * total minus the hours already entered on the earlier rows, rounded to 0.1
 * and never negative. (#128 — "the maths does itself".)
 */
export function splitDayRemainder(
  totalHours: number,
  filledHours: ReadonlyArray<number>
): number {
  const used = filledHours.reduce((s, h) => s + (Number.isFinite(h) ? h : 0), 0);
  const remainder = Math.round((totalHours - used) * 10) / 10;
  return remainder > 0 ? remainder : 0;
}

/**
 * True if the supplied date string is within the legacy backdate window
 * (14 days back, no future dates). Used by the date picker.
 */
export function isWithinBackdateWindow(date: string, today: Date = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const entryDate = new Date(date + "T00:00:00");
  const todayCopy = new Date(today);
  todayCopy.setHours(0, 0, 0, 0);
  const diffDays = (todayCopy.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays <= MAX_BACKDATE_DAYS && diffDays >= -1;
}

/**
 * Validate a `?fixDate=` deep-link param (from the "Hours rejected" push
 * notification or the Needs You feed) into a usable YYYY-MM-DD string, or
 * null. Same shape rule as the legacy /my-day handler — anything else (extra
 * segments, prose, malformed dates) is ignored rather than erroring, since a
 * stale or mangled notification must never break the worker's home screen.
 */
export function parseFixDate(raw: string | string[] | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

/**
 * Pull the primary job id from an entry for display purposes. Used by the
 * worker's history list which shows one job per row.
 */
export function primaryJobId(entry: Pick<TimeEntry, "allocations">): string | null {
  const allocations: ReadonlyArray<TimeEntryAllocation> = entry.allocations;
  for (const allocation of allocations) {
    if (allocation.jobId) return allocation.jobId;
  }
  return null;
}

/**
 * Pick the worker's most-recently-logged job, for pre-selecting the My Day
 * hours picker so the common case ("same job as last time") is one tap. Scans
 * `entries` for the newest-dated one whose primary job is STILL one of
 * `assignableJobIds` — so an archived/unassigned old job never becomes the
 * default, and the returned date is real (it's that entry's own date, never
 * fabricated). Status-agnostic: any logged day counts as "your last job".
 *
 * Returns `{ jobId, date }` or null when nothing matches (the worker hasn't
 * logged within the loaded window, or their last job is no longer assignable);
 * the caller then falls back to the sole job or an explicit pick. Order of
 * `entries` is irrelevant — the newest date wins by comparison. Pure.
 */
export function lastLoggedJobFor(
  entries: ReadonlyArray<Pick<TimeEntry, "date" | "allocations">>,
  assignableJobIds: ReadonlyArray<string>
): { jobId: string; date: string } | null {
  const assignable = new Set(assignableJobIds);
  let best: { jobId: string; date: string } | null = null;
  for (const entry of entries) {
    const jobId = primaryJobId(entry);
    if (!jobId || !assignable.has(jobId)) continue;
    // YYYY-MM-DD compares lexicographically as chronologically.
    if (!best || entry.date > best.date) best = { jobId, date: entry.date };
  }
  return best;
}

/**
 * Roll the server's flat `missing` array (one row per worker×weekday with no
 * entry) into the groupings the UI needs, without re-deriving any detection
 * logic — the server already decided *who* is missing *when* (assigned crew,
 * weekdays, past/today, role/job-scoped). This helper only re-shapes that
 * truth so the command-centre card can say "No hours from N workers" honestly
 * and the admin weekly surface can list it by worker or by day.
 *
 * Returns:
 *   - total:       missing worker×date cells
 *   - workerCount: distinct workers with at least one missing day
 *   - dateCount:   distinct dates with at least one missing worker
 *   - oldestDate:  earliest missing date (for an "oldest" age label), or null
 *   - byWorker:    grouped per worker, most-missing first, dates ascending
 *   - byDate:      grouped per date ascending, workers alphabetical
 */
export function summariseMissing(missing: ReadonlyArray<MissingLog>): {
  total: number;
  workerCount: number;
  dateCount: number;
  oldestDate: string | null;
  byWorker: Array<{ userId: string; userName: string; role: string | null; dates: string[] }>;
  byDate: Array<{
    date: string;
    workers: Array<{ userId: string; userName: string; role: string | null }>;
  }>;
} {
  const byWorkerMap = new Map<
    string,
    { userId: string; userName: string; role: string | null; dates: Set<string> }
  >();
  const byDateMap = new Map<
    string,
    Map<string, { userId: string; userName: string; role: string | null }>
  >();

  for (const m of missing) {
    const role = m.role ?? null;

    let worker = byWorkerMap.get(m.userId);
    if (!worker) {
      worker = { userId: m.userId, userName: m.userName, role, dates: new Set() };
      byWorkerMap.set(m.userId, worker);
    }
    worker.dates.add(m.date);

    let dateGroup = byDateMap.get(m.date);
    if (!dateGroup) {
      dateGroup = new Map();
      byDateMap.set(m.date, dateGroup);
    }
    if (!dateGroup.has(m.userId)) {
      dateGroup.set(m.userId, { userId: m.userId, userName: m.userName, role });
    }
  }

  const byWorker = Array.from(byWorkerMap.values())
    .map((w) => ({
      userId: w.userId,
      userName: w.userName,
      role: w.role,
      dates: Array.from(w.dates).sort(),
    }))
    .sort((a, b) => b.dates.length - a.dates.length || a.userName.localeCompare(b.userName));

  const byDate = Array.from(byDateMap.entries())
    .map(([date, workers]) => ({
      date,
      workers: Array.from(workers.values()).sort((a, b) => a.userName.localeCompare(b.userName)),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const oldestDate = byDate.length > 0 ? byDate[0]!.date : null;

  return {
    total: missing.length,
    workerCount: byWorkerMap.size,
    dateCount: byDateMap.size,
    oldestDate,
    byWorker,
    byDate,
  };
}
