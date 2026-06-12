import type { MissingLog, TimeEntry } from "./types";
import { addDays, weekEndOf } from "./service";

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
  | "leave"
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
  hours: number | null;
  note: string | null;
  rejectedReason: string | null;
  /** Committed payroll run that included this day, when stamped (#126). */
  exportId: string | null;
  /** Approved leave type covering this day (#333) — set on status "leave",
   *  AND on a logged day that overlaps approved leave (the office flag). */
  leaveType: string | null;
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
  /** Human-readable blocking lines, e.g. "Wed missing", "Fri rejected". */
  blockers: string[];
  /** Seven cells, Monday → Sunday. */
  days: WeeklyHoursDay[];
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
  /** Monday of the week (callers use weekStartOf()). */
  weekStart: string;
  /** Today in the business timezone — future-day classification. */
  todayISO: string;
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
  for (const m of missing) {
    missingSet.add(`${m.userId}|${m.date}`);
    if (!names.has(m.userId)) {
      names.set(m.userId, { name: m.userName ?? m.userId, role: m.role ?? null });
    }
  }

  const workers: WeeklyWorkerHours[] = [];
  for (const [workerId, who] of names) {
    const days: WeeklyHoursDay[] = [];
    let approvedHours = 0;
    let approvedCount = 0;
    let submittedCount = 0;
    let rejectedCount = 0;
    let draftCount = 0;
    let missingCount = 0;
    const blockers: string[] = [];

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
      } else if (leaveByKey.has(`${workerId}|${date}`)) {
        // #333: approved leave — not an expectation, never "missing".
        status = "leave";
      } else if (missingSet.has(`${workerId}|${date}`)) {
        status = "missing";
      } else if (isWeekend) {
        // A weekend with no entry is not required — whether already past or
        // still to come (same convention as the Phil strip's "off").
        status = "not-required";
      } else if (date > todayISO) {
        status = "future";
      } else {
        // A past weekday the server doesn't track for this worker — not an
        // expectation we can honestly claim.
        status = "not-required";
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
      } else if (status === "draft") {
        draftCount += 1;
        blockers.push(`${weekday} draft — not submitted`);
      } else if (status === "missing") {
        missingCount += 1;
        blockers.push(`${weekday} missing`);
      }

      const leaveType = leaveByKey.get(`${workerId}|${date}`) ?? null;
      if (entry && leaveType) {
        // Logged hours on an approved-leave day still count as WORK, but the
        // office should see the collision (#333).
        blockers.push(`${weekday} logged while on leave`);
      }

      days.push({
        date,
        weekday,
        status,
        entryId: entry?.id ?? null,
        jobLabel: entry ? jobLabelFor(entry) : null,
        hours: entry ? (entry.totalHours ?? null) : null,
        note: entry?.notes ?? null,
        rejectedReason: entry?.rejectedReason ?? null,
        exportId: entry?.exportId ?? null,
        leaveType,
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
      blockers,
      days,
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
    case "leave":
      return "On leave";
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
