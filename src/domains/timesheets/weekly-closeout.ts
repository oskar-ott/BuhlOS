import type { MissingLog, TimeEntry, TimeEntryAllocation } from "./types";
import { addDays, weekEndOf } from "./service";
import { dayTypeLabel } from "./format";

/**
 * Weekly hours closeout — the pure derivation behind /hours/weekly.
 *
 * Turns one week of the existing /api/time-entries-overview response
 * (entries + the server's missing-day detection) into a decision-first
 * model: who is payroll-ready, who is blocking, and what exactly happens
 * next. No new endpoint, no new storage — this is a projection over the
 * daily entries the #112 loop already maintains.
 *
 * HONESTY RULES (the same ones the admin /hours page already lives by):
 *   - A day is "missing" ONLY when the server's missing[] says so (assigned
 *     crew, weekdays only, past/today only — api/time-entries-overview.js).
 *     We never re-derive or guess missing days client-side.
 *   - Future days are "future", never missing.
 *   - Weekends with no entry are "not-required", never missing.
 *   - A past weekday with no entry for a worker the server does NOT track
 *     (e.g. roles outside its crew filter) is "not-required" — we don't
 *     invent expectations the data can't support.
 *   - payroll-ready is only claimed when every included worker has zero
 *     submitted / rejected / draft / missing days. An empty week is NOT
 *     payroll-ready — it's an honest empty state.
 *
 * The repo has a real "draft" status (logged but not submitted) — the
 * mission-level model is extended with it rather than hiding it: a draft
 * blocks payroll exactly like a rejected day (worker action needed).
 */

export type WeeklyDayStatus =
  | "approved"
  | "submitted"
  | "rejected"
  | "draft"
  | "missing"
  /** A past weekday with no entry in a week that HASN'T ended yet. The crew
   *  logs hours weekly — often the whole week at its end (owner directive
   *  2026-08-08) — so mid-week an un-logged Monday is expected, not a
   *  blocker. It becomes "missing" only once the Mon–Sun week is over. */
  | "pending"
  | "leave"
  | "holiday"
  | "future"
  | "not-required";

export type WorkerWeekReadiness =
  | "payroll-ready"
  | "needs-review" // submitted days waiting on an approver
  | "needs-worker" // rejected and/or draft days waiting on the worker
  | "missing-hours"; // nothing wrong in the system — days simply not logged

export interface WeeklyHoursDay {
  /** YYYY-MM-DD. */
  date: string;
  /** "Mon" … "Sun". */
  weekday: string;
  status: WeeklyDayStatus;
  entryId: string | null;
  /** "Smith St Rewire", "2 jobs" for a split day, "No job" for a null
   *  allocation, or null when there is no entry. */
  jobLabel: string | null;
  /** The day's REAL allocations, straight off the entry (null when there is no
   *  entry). Carried so the phone's day review can offer the office's "fix the
   *  hours and approve" on a split day without a second fetch — the editor
   *  needs each job's own time, not just the label. Display/edit input only;
   *  every roll-up above stays totalHours-based. */
  allocations: TimeEntryAllocation[] | null;
  hours: number | null;
  /** #130: STORED ordinary/overtime portions of `hours`, or null when the day
   *  has no entry. Read straight from the entry — never re-derived. Carried as
   *  a pair so the split presenter's honesty guard (ordinary + overtime ≈
   *  total) stays meaningful. The approvedHours roll-up stays totalHours-based;
   *  this is display only. */
  ordinaryHours: number | null;
  overtimeHours: number | null;
  note: string | null;
  rejectedReason: string | null;
  /** Committed payroll run that included this day, when stamped (#126). */
  exportId: string | null;
  /** Approved leave type covering this day (#333) — set on status "leave",
   *  AND on a logged day that overlaps approved leave (the office flag). */
  leaveType: string | null;
  /** Public-holiday name (#137) — set when this date is a public holiday,
   *  whether or not the worker logged it. e.g. "Good Friday". */
  holidayName: string | null;
}

export interface WeeklyJobSlice {
  jobId: string | null;
  jobName: string;
  hours: number;
}

export interface WeeklyWorkerHours {
  workerId: string;
  workerName: string;
  workerRole: string | null;
  readiness: WorkerWeekReadiness;
  approvedHours: number;
  approvedCount: number;
  submittedCount: number;
  rejectedCount: number;
  draftCount: number;
  missingCount: number;
  /** Un-logged past weekdays in a week that hasn't ended (see "pending" on
   *  WeeklyDayStatus) — expected under weekly logging, so never a blocker
   *  here; pay-run still refuses to call such a week clean. */
  pendingCount: number;
  /** Human-readable blocking lines, e.g. "Wed missing", "Fri rejected". */
  blockers: string[];
  /** §5 mockup "needs a look" lines — site-language reasons the office should
   *  eyeball before approving (overtime, missing day, rejected/draft, logged on
   *  leave). Derived from the SAME real signals as `blockers`; never invented. */
  needsLookReasons: string[];
  /** Seven cells, Monday → Sunday. */
  days: WeeklyHoursDay[];
  /** §5 mockup weekly TOTAL — every LOGGED day (approved/submitted/rejected/
   *  draft) regardless of approval state, so the row's "{h}h" matches the day
   *  numbers a boss can see in the strip. (`approvedHours` stays the
   *  payroll-relevant subset.) Never includes missing/leave/holiday/empty. */
  loggedHours: number;
  /** §5 mockup job-split chips — logged hours per job across the week, from the
   *  entries' allocations. >1 entry ⇒ render "Split this week". */
  jobBreakdown: WeeklyJobSlice[];
  /** Effective LOADED-COST rate (integer cents) for this worker, when the admin
   *  caller supplied one (api/cost-rates.js, effective on the week's Monday).
   *  null when no rate exists OR the viewer can't read rates (a leading hand) —
   *  the row then shows "—", never a fabricated $0. */
  costRateCents: number | null;
  /** §5 mockup labour $ for the row = round(loggedHours × costRateCents), in
   *  integer cents. null exactly when costRateCents is null (honest "—"). */
  labourCents: number | null;
}

export interface WeeklyApprovedJobSlice {
  jobId: string | null;
  jobName: string;
  hours: number;
}

export interface WeeklyHoursCloseout {
  weekStart: string;
  weekEnd: string;
  /** Workers needing action first (review → worker → missing), then
   *  payroll-ready; name-sorted within each band. */
  workers: WeeklyWorkerHours[];
  /** APPROVED hours per job for the week — the payroll-relevant slice
   *  (the /hours rollup's byJob mixes all statuses). */
  approvedByJob: WeeklyApprovedJobSlice[];
  summary: {
    workersReady: number;
    workersNeedAction: number;
    submittedDays: number;
    rejectedDays: number;
    draftDays: number;
    missingDays: number;
    approvedHours: number;
    /** §5 hero "{totalHrs}h logged" — sum of every worker's LOGGED hours
     *  across the week (all statuses), the figure the day-number strip adds to. */
    loggedHours: number;
    /** §5 hero "${labour} labour" — sum of labourCents across ONLY the workers
     *  who have a known cost rate (integer cents). 0 when no worker is rated;
     *  `ratedWorkers` lets the hero omit the $ affordance gracefully then. */
    labourCents: number;
    /** How many workers in the run carry a cost rate (drives whether the hero
     *  shows a labour figure at all — no column of "—"). */
    ratedWorkers: number;
    payrollReady: boolean;
  };
}

export interface WeeklyCloseoutInput {
  /** Entries from /api/time-entries-overview for [weekStart, weekEnd] —
   *  already enriched with userName/userRole + per-allocation jobName. */
  entries: ReadonlyArray<TimeEntry>;
  /** The server's missing-day detection for the same range. */
  missing: ReadonlyArray<MissingLog>;
  /** Approved leave days from the same overview response (#333). */
  leave?: ReadonlyArray<{ date: string; userId: string; type: string }>;
  /** Public-holiday days from the same overview response (#137) — per-date
   *  (whole crew), not per-user. */
  holidays?: ReadonlyArray<{ date: string; name: string }>;
  /** Monday of the week (callers use weekStartOf()). */
  weekStart: string;
  /** Today in the business timezone — future-day classification. */
  todayISO: string;
  /** §5: effective LOADED-COST rate per worker (integer cents), keyed by
   *  userId — supplied ONLY by the admin-tier page after an admin-gated
   *  /api/cost-rates read. Omit entirely (or pass {}) when the viewer can't read
   *  rates (a leading hand) or the rates are unknown; the model then carries
   *  null cost everywhere and the surface shows "—", never a fabricated $0.
   *  Resolved to the rate effective on the week's Monday so a past week is
   *  costed at the rate that was effective THEN (cost-rates' append-only law). */
  costRatesByWorker?: Readonly<Record<string, number>>;
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const READINESS_RANK: Record<WorkerWeekReadiness, number> = {
  "needs-review": 0,
  "needs-worker": 1,
  "missing-hours": 2,
  "payroll-ready": 3,
};

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function jobLabelFor(entry: TimeEntry): string | null {
  // A day-type day (TAFE / sick / holiday, 2026-08-10) names itself — its
  // null jobId is by design, never "No job".
  const typed = dayTypeLabel(entry.dayType);
  if (typed) return typed;
  const allocations = entry.allocations ?? [];
  if (allocations.length === 0) return null;
  if (allocations.length > 1) return `${allocations.length} jobs`;
  const a = allocations[0]!;
  if (!a.jobId) return "No job";
  return a.jobName ?? a.jobId;
}

export function buildWeeklyHoursCloseout(input: WeeklyCloseoutInput): WeeklyHoursCloseout {
  const { weekStart, todayISO } = input;
  const weekEnd = weekEndOf(weekStart);
  // The chase starts when the Mon–Sun week is over (owner directive
  // 2026-08-08): until then an un-logged past weekday is "pending", not
  // "missing" — the crew logs weekly, often the whole week at its end.
  const weekEnded = weekEnd < todayISO;

  // Defensive range filter — callers fetch exactly the week, but the model
  // must stay correct if handed a wider range.
  const entries = input.entries.filter((e) => e.date >= weekStart && e.date <= weekEnd);
  const missing = input.missing.filter((m) => m.date >= weekStart && m.date <= weekEnd);

  // ── Worker universe: anyone with an entry OR a server-flagged missing day.
  // Never anyone else — no fake workers.
  const names = new Map<string, { name: string; role: string | null }>();
  const entryByWorkerDate = new Map<string, TimeEntry>();
  for (const e of entries) {
    if (!names.has(e.userId)) {
      names.set(e.userId, { name: e.userName ?? e.userId, role: e.userRole ?? null });
    }
    // One entry per worker+date is API-enforced (POST 409); last write is
    // deterministic enough as a defensive fallback.
    entryByWorkerDate.set(`${e.userId}|${e.date}`, e);
  }
  const missingSet = new Set<string>();
  const leaveByKey = new Map<string, string>();
  for (const l of input.leave ?? []) leaveByKey.set(`${l.userId}|${l.date}`, l.type);
  // #137: public holidays are per-date (whole crew), not per-user.
  const holidayNameByDate = new Map<string, string>();
  for (const h of input.holidays ?? []) holidayNameByDate.set(h.date, h.name);
  for (const m of missing) {
    missingSet.add(`${m.userId}|${m.date}`);
    if (!names.has(m.userId)) {
      names.set(m.userId, { name: m.userName ?? m.userId, role: m.role ?? null });
    }
  }

  const costRates = input.costRatesByWorker ?? {};

  const workers: WeeklyWorkerHours[] = [];
  for (const [workerId, who] of names) {
    const days: WeeklyHoursDay[] = [];
    let approvedHours = 0;
    let loggedHours = 0;
    let approvedCount = 0;
    let submittedCount = 0;
    let rejectedCount = 0;
    let draftCount = 0;
    let missingCount = 0;
    let pendingCount = 0;
    const blockers: string[] = [];
    const needsLookReasons: string[] = [];
    // §5 job-split chips: logged hours per job across the week, allocation-level
    // so split days attribute correctly. Insertion-ordered for a stable palette.
    const jobHours = new Map<string, { jobId: string | null; jobName: string; hours: number }>();

    for (let i = 0; i < 7; i++) {
      const date = addDays(weekStart, i);
      const weekday = WEEKDAY_LABELS[i]!;
      const isWeekend = i >= 5; // Sat=5, Sun=6
      const entry = entryByWorkerDate.get(`${workerId}|${date}`) ?? null;

      let status: WeeklyDayStatus;
      if (entry) {
        status =
          entry.status === "approved" ||
          entry.status === "submitted" ||
          entry.status === "rejected" ||
          entry.status === "draft"
            ? entry.status
            : "draft";
      } else if (holidayNameByDate.has(date)) {
        // #137: a public holiday is nobody's required day — show it as such,
        // never "missing" or "leave". (A worked holiday keeps its entry above;
        // a public holiday inside a leave span is paid as a holiday, not leave.)
        status = "holiday";
      } else if (leaveByKey.has(`${workerId}|${date}`)) {
        // #333: approved leave — not an expectation, never "missing".
        status = "leave";
      } else if (missingSet.has(`${workerId}|${date}`)) {
        status = weekEnded ? "missing" : "pending";
      } else if (isWeekend) {
        // A weekend with no entry is not required for payroll — whether already
        // past or still to come. (Phil now lets a worker LOG a weekend if they
        // worked it, but an unworked weekend is never counted as missing here or
        // in the strip's missed tally.)
        status = "not-required";
      } else if (date > todayISO) {
        status = "future";
      } else {
        // A past weekday the server doesn't track for this worker — not an
        // expectation we can honestly claim.
        status = "not-required";
      }

      // §5: every LOGGED day (any of the four entry statuses) feeds the row's
      // weekly total + job-split, regardless of approval state. Missing / leave
      // / holiday / future / not-required carry no hours and never count here.
      const isLogged =
        status === "approved" ||
        status === "submitted" ||
        status === "rejected" ||
        status === "draft";
      if (entry && isLogged) {
        loggedHours += entry.totalHours ?? 0;
        for (const a of entry.allocations ?? []) {
          const key = a.jobId ?? "__internal__";
          const hours = Number(a.hours) || 0;
          const existing = jobHours.get(key);
          if (existing) {
            existing.hours += hours;
          } else {
            jobHours.set(key, {
              jobId: a.jobId ?? null,
              jobName: a.jobId ? (a.jobName ?? a.jobId) : "Internal (no job)",
              hours,
            });
          }
        }
      }

      if (status === "approved") {
        approvedCount += 1;
        approvedHours += entry?.totalHours ?? 0;
      } else if (status === "submitted") {
        submittedCount += 1;
        blockers.push(`${weekday} waiting for review`);
      } else if (status === "rejected") {
        rejectedCount += 1;
        blockers.push(`${weekday} rejected`);
        needsLookReasons.push(
          entry?.rejectedReason
            ? `${weekday} bounced back — "${entry.rejectedReason}". Waiting on the worker.`
            : `${weekday} was rejected — waiting on the worker to fix it.`,
        );
      } else if (status === "draft") {
        draftCount += 1;
        blockers.push(`${weekday} draft — not submitted`);
        needsLookReasons.push(`${weekday} is still a draft — not sent in yet.`);
      } else if (status === "missing") {
        missingCount += 1;
        blockers.push(`${weekday} missing`);
        needsLookReasons.push(`No entry for ${weekday} — were they on site?`);
      } else if (status === "pending") {
        // Expected under weekly logging — counted so pay-run can refuse to
        // sweep an unfinished week, but never a blocker or a "needs a look".
        pendingCount += 1;
      }

      // §5 overtime flag — a long day the boss should eyeball. Read straight off
      // the stored entry (overtimeHours > 0, or a >10h day) — never re-derived.
      if (entry && isLogged) {
        const ot = entry.overtimeHours ?? 0;
        const long = (entry.totalHours ?? 0) > 10;
        if (ot > 0 || long) {
          needsLookReasons.push(
            ot > 0
              ? `${weekday} carries ${round2(ot)}h overtime — needs your nod.`
              : `${weekday} ran over 10h — overtime needs your nod.`,
          );
        }
      }

      const leaveType = leaveByKey.get(`${workerId}|${date}`) ?? null;
      if (entry && leaveType) {
        // Logged hours on an approved-leave day still count as WORK, but the
        // office should see the collision (#333).
        blockers.push(`${weekday} logged while on leave`);
        needsLookReasons.push(`${weekday} logged while on ${leaveType} leave.`);
      }

      days.push({
        date,
        weekday,
        status,
        entryId: entry?.id ?? null,
        jobLabel: entry ? jobLabelFor(entry) : null,
        allocations: entry ? [...(entry.allocations ?? [])] : null,
        hours: entry ? (entry.totalHours ?? null) : null,
        // #130: carry the STORED ordinary/OT portions through the projection
        // (they were dropped before). Roll-up math below is unchanged
        // (totalHours-based).
        ordinaryHours: entry ? (entry.ordinaryHours ?? null) : null,
        overtimeHours: entry ? (entry.overtimeHours ?? null) : null,
        note: entry?.notes ?? null,
        rejectedReason: entry?.rejectedReason ?? null,
        exportId: entry?.exportId ?? null,
        leaveType,
        holidayName: holidayNameByDate.get(date) ?? null,
      });
    }

    const readiness: WorkerWeekReadiness =
      submittedCount > 0
        ? "needs-review"
        : rejectedCount > 0 || draftCount > 0
          ? "needs-worker"
          : missingCount > 0
            ? "missing-hours"
            : "payroll-ready";

    const roundedLogged = round2(loggedHours);
    // §5 labour $: hours × rate, integer cents. null exactly when no rate is
    // known for this worker — the surface shows "—", never $0.
    const rawRate = costRates[workerId];
    const costRateCents =
      typeof rawRate === "number" && Number.isFinite(rawRate) && rawRate > 0
        ? Math.round(rawRate)
        : null;
    const labourCents =
      costRateCents != null ? Math.round(roundedLogged * costRateCents) : null;

    // Job-split chips — logged hours per job, biggest first; "__internal__"
    // (null-job allocations) sorts like any other slice.
    const jobBreakdown: WeeklyJobSlice[] = [...jobHours.values()]
      .map((j) => ({ jobId: j.jobId, jobName: j.jobName, hours: round2(j.hours) }))
      .filter((j) => j.hours > 0)
      .sort((a, b) => b.hours - a.hours);

    workers.push({
      workerId,
      workerName: who.name,
      workerRole: who.role,
      readiness,
      approvedHours: round2(approvedHours),
      approvedCount,
      submittedCount,
      rejectedCount,
      draftCount,
      missingCount,
      pendingCount,
      blockers,
      needsLookReasons,
      days,
      loggedHours: roundedLogged,
      jobBreakdown,
      costRateCents,
      labourCents,
    });
  }

  workers.sort((a, b) => {
    const rank = READINESS_RANK[a.readiness] - READINESS_RANK[b.readiness];
    if (rank !== 0) return rank;
    return a.workerName.localeCompare(b.workerName);
  });

  // ── Approved hours per job (payroll-relevant slice). Allocation-level so
  // split days attribute correctly; only approved entries count.
  const byJob = new Map<string, { jobId: string | null; jobName: string; hours: number }>();
  for (const e of entries) {
    if (e.status !== "approved") continue;
    for (const a of e.allocations ?? []) {
      const key = a.jobId ?? "__internal__";
      const existing = byJob.get(key);
      const hours = Number(a.hours) || 0;
      if (existing) {
        existing.hours += hours;
      } else {
        byJob.set(key, {
          jobId: a.jobId ?? null,
          // Same label the overview endpoint uses for null-job allocations.
          jobName: a.jobId ? (a.jobName ?? a.jobId) : "Internal (no job)",
          hours,
        });
      }
    }
  }
  const approvedByJob = [...byJob.values()]
    .map((j) => ({ ...j, hours: round2(j.hours) }))
    .sort((a, b) => b.hours - a.hours);

  const summary = {
    workersReady: workers.filter((w) => w.readiness === "payroll-ready").length,
    workersNeedAction: workers.filter((w) => w.readiness !== "payroll-ready").length,
    submittedDays: workers.reduce((n, w) => n + w.submittedCount, 0),
    rejectedDays: workers.reduce((n, w) => n + w.rejectedCount, 0),
    draftDays: workers.reduce((n, w) => n + w.draftCount, 0),
    missingDays: workers.reduce((n, w) => n + w.missingCount, 0),
    approvedHours: round2(workers.reduce((n, w) => n + w.approvedHours, 0)),
    loggedHours: round2(workers.reduce((n, w) => n + w.loggedHours, 0)),
    // Labour sums ONLY rated workers — an unrated worker contributes 0, never a
    // guessed cost. The hero hides the figure entirely when ratedWorkers === 0.
    labourCents: workers.reduce((n, w) => n + (w.labourCents ?? 0), 0),
    ratedWorkers: workers.filter((w) => w.costRateCents != null).length,
    // An empty week can't honestly be "ready" — there is nothing to pay.
    payrollReady:
      workers.length > 0 && workers.every((w) => w.readiness === "payroll-ready"),
  };

  return { weekStart, weekEnd, workers, approvedByJob, summary };
}

/** Boss-facing label for a worker's week. */
export function readinessLabel(readiness: WorkerWeekReadiness): string {
  switch (readiness) {
    case "payroll-ready":
      return "Ready";
    case "needs-review":
      return "Needs review";
    case "needs-worker":
      return "Waiting for worker";
    case "missing-hours":
      return "Missing hours";
  }
}

/** Boss-facing label for one day. */
export function weeklyDayStatusLabel(status: WeeklyDayStatus): string {
  switch (status) {
    case "approved":
      return "Approved";
    case "submitted":
      return "Submitted";
    case "rejected":
      return "Rejected";
    case "draft":
      return "Draft — not submitted";
    case "missing":
      return "Missing";
    case "pending":
      return "Not logged yet";
    case "leave":
      return "On leave";
    case "holiday":
      return "Public holiday";
    case "future":
      return "—";
    case "not-required":
      return "—";
  }
}

/** Bulk-approve endpoint cap (api/time-entries-bulk-approve.js MAX_ENTRIES). */
export const BULK_APPROVE_MAX = 50;

/**
 * The {userId, date} pairs for one worker's SUBMITTED days — the exact body
 * "Approve week" sends to POST /api/time-entries-bulk-approve. Pure so the
 * selection rule is unit-tested: only submitted days qualify (missing,
 * rejected, draft, approved and future days are never touched), capped at
 * the endpoint maximum (a single week is at most 7, so the cap is a guard,
 * not a path).
 */
export function submittedWeekSelection(
  worker: WeeklyWorkerHours,
): Array<{ userId: string; date: string }> {
  return worker.days
    .filter((d) => d.status === "submitted")
    .map((d) => ({ userId: worker.workerId, date: d.date }))
    .slice(0, BULK_APPROVE_MAX);
}
