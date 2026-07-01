import { buildPayRun, shortHours } from "./pay-run";
import type {
  WeeklyHoursCloseout,
  WeeklyWorkerHours,
} from "./weekly-closeout";

/**
 * Mobile weekly-hours approval — the pure view-model behind
 * WeeklyHoursApprovalMobile (the phone surface on /hours/weekly).
 *
 * The office (the boss) clears the crew's week from a phone before the payroll
 * run, one person at a time. This module is the PROJECTION that shapes what
 * that surface shows — it never fetches, never mutates, and never invents a
 * number. It sits on top of the SAME `buildWeeklyHoursCloseout` model the
 * desktop board uses, so the two surfaces can never disagree.
 *
 * HONESTY (the project's #1 law — no fake UI, no invented numbers, P7):
 *   - The three bands come straight from the model's `readiness` +
 *     `submittedCount`. A worker only exists here if the model already put them
 *     in the run (an entry or a server-flagged missing day) — never a fabricated
 *     name.
 *   - Overtime is read from the STORED per-day `overtimeHours` (the same field
 *     the office approvals queue + Phil week already display via `otSplitLabel`).
 *     We do NOT re-invent a weekly "over 38h" rule the rest of the app doesn't
 *     use — that would be a payroll rule the data can't back.
 *   - The ordinary portion is `logged − overtime`, guarded to ≥ 0.
 */

/**
 * Which of the three phone bands a worker's week falls into.
 *   - "to-approve" — has submitted days waiting on the office (the actionable
 *     set; may ALSO carry rejected/draft/missing days, which surface in the
 *     review sheet, but the boss can still approve the submitted ones).
 *   - "approved"   — the week is settled: payroll-ready, nothing outstanding.
 *   - "waiting"    — waiting on the WORKER (rejected / draft / missing) with no
 *     submitted day to action here; shown for context, not approvable on mobile.
 */
export type MobileBand = "to-approve" | "approved" | "waiting";

export function mobileBand(worker: WeeklyWorkerHours): MobileBand {
  if (worker.submittedCount > 0) return "to-approve";
  if (worker.readiness === "payroll-ready") return "approved";
  return "waiting";
}

export interface MobileWorkerBands {
  /** Weeks with submitted days to clear — the queue the boss steps through. */
  toApprove: WeeklyWorkerHours[];
  /** Fully settled weeks (payroll-ready). */
  approved: WeeklyWorkerHours[];
  /** Weeks waiting on the worker (rejected / draft / missing). */
  waiting: WeeklyWorkerHours[];
}

/**
 * Split the run into the three phone bands, preserving the model's ordering
 * (needs-review → needs-worker → missing-hours → payroll-ready, name-sorted
 * within each). So `toApprove` is already in the order the stepper wants.
 */
export function partitionMobileWorkers(closeout: WeeklyHoursCloseout): MobileWorkerBands {
  const toApprove: WeeklyWorkerHours[] = [];
  const approved: WeeklyWorkerHours[] = [];
  const waiting: WeeklyWorkerHours[] = [];
  for (const w of closeout.workers) {
    const band = mobileBand(w);
    if (band === "to-approve") toApprove.push(w);
    else if (band === "approved") approved.push(w);
    else waiting.push(w);
  }
  return { toApprove, approved, waiting };
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export interface WorkerOrdOt {
  /** Ordinary hours across the week = logged − overtime (≥ 0). */
  ordinary: number;
  /** Overtime hours across the week — sum of the STORED per-day OT. */
  overtime: number;
  /** True when any stored overtime landed in the week. */
  hasOvertime: boolean;
}

/**
 * The week's ordinary / overtime split for a worker, from the STORED per-day
 * `overtimeHours` only (never re-derived). Ordinary is the remainder of the
 * logged total, so `ordinary + overtime === loggedHours` by construction.
 */
export function workerOrdOtSplit(worker: WeeklyWorkerHours): WorkerOrdOt {
  let overtime = 0;
  for (const d of worker.days) {
    if (d.overtimeHours != null && d.overtimeHours > 0) overtime += d.overtimeHours;
  }
  overtime = round2(overtime);
  const ordinary = round2(Math.max(0, worker.loggedHours - overtime));
  return { ordinary, overtime, hasOvertime: overtime > 0 };
}

/** Long (stored-OT or >10h) days this week — the "needs your nod" sub-signal. */
export function workerLongDayCount(worker: WeeklyWorkerHours): number {
  return worker.days.filter(
    (d) => (d.overtimeHours != null && d.overtimeHours > 0) || (d.hours != null && d.hours > 10),
  ).length;
}

/**
 * Hours across a worker's SUBMITTED days — what "Approve week" actually
 * approves. A mixed week may also hold already-approved days, so this is NOT
 * always `loggedHours`; the approve button/toast must name this figure, never
 * the week total, or it overstates what a tap does.
 */
export function submittedHoursOf(worker: WeeklyWorkerHours): number {
  let hours = 0;
  for (const d of worker.days) {
    if (d.status === "submitted" && d.hours != null) hours += d.hours;
  }
  return round2(hours);
}

export interface MobileSummary {
  /** "Mon 20 May – Sun 26 May". */
  rangeLabel: string;
  /** Workers in the run. */
  crewCount: number;
  /** Weeks already payroll-ready. */
  readyCount: number;
  /** Weeks with submitted days still to clear. */
  toApproveCount: number;
  /** Weeks waiting on the worker (rejected / draft / missing). */
  waitingCount: number;
  /** LOGGED hours across the run, compact ("412", "412.5"). */
  loggedHoursShort: string;
  /** Overtime hours across the run, compact ("6", "6.5"). "0" when none. */
  overtimeShort: string;
  /** True when there is overtime to eyeball anywhere in the run. */
  hasOvertime: boolean;
  /** 0..100 = readyCount / crewCount, rounded. */
  progressPct: number;
  /** Workers flagged for a human look (rejected / draft / missing). */
  needLookCount: number;
  /** True only when there is a crew AND every week is payroll-ready. */
  allReady: boolean;
}

/**
 * The phone summary readout. Reuses the desktop pay-run hero for the shared
 * figures (range, crew, ready, logged, progress) and adds the run-wide overtime
 * total + the band counts the mobile lists need.
 */
export function mobileSummary(closeout: WeeklyHoursCloseout): MobileSummary {
  const { hero } = buildPayRun(closeout);
  let overtime = 0;
  for (const w of closeout.workers) overtime += workerOrdOtSplit(w).overtime;
  overtime = round2(overtime);

  const bands = partitionMobileWorkers(closeout);

  return {
    rangeLabel: hero.rangeLabel,
    crewCount: hero.crewCount,
    readyCount: hero.readyCount,
    toApproveCount: bands.toApprove.length,
    waitingCount: bands.waiting.length,
    loggedHoursShort: hero.loggedHoursShort,
    overtimeShort: shortHours(overtime) ?? "0",
    hasOvertime: overtime > 0,
    progressPct: hero.progressPct,
    needLookCount: hero.needLookCount,
    allReady: hero.allReady,
  };
}

/** The worker ids to step through in "Review each", in queue order. */
export function reviewQueueIds(closeout: WeeklyHoursCloseout): string[] {
  return partitionMobileWorkers(closeout).toApprove.map((w) => w.workerId);
}

/**
 * Site-language reasons for sending a week back (the phone "Query" flow). Each
 * becomes the REQUIRED reason on the existing reject endpoint — the worker gets
 * it as a push with a one-tap fix link. "Other" always pairs with a typed note.
 */
export const MOBILE_QUERY_REASONS = [
  "Wrong job",
  "Hours look high",
  "Missing a day",
  "Check the daywork",
  "Other",
] as const;

export type MobileQueryReason = (typeof MOBILE_QUERY_REASONS)[number];

/**
 * Build the REQUIRED reject reason string from a chosen chip + optional note.
 * "Other" needs the note to carry the meaning; the chips carry their own. Pure
 * so the exact string the worker sees is unit-tested. Returns null when there's
 * nothing to say (an "Other" with no note) — the caller then keeps the send
 * button disabled rather than rejecting with an empty reason (the API 400s).
 */
export function buildQueryReason(
  reason: MobileQueryReason,
  note?: string,
): string | null {
  const trimmed = (note ?? "").trim();
  if (reason === "Other") return trimmed.length > 0 ? trimmed : null;
  return trimmed.length > 0 ? `${reason} — ${trimmed}` : reason;
}
