import { buildPayRun, shortHours } from "./pay-run";
import type {
  WeeklyHoursCloseout,
  WeeklyHoursDay,
  WeeklyWorkerHours,
} from "./weekly-closeout";

/**
 * Weekly review — the pure view-model behind BOTH one-at-a-time weekly-hours
 * review surfaces on /hours/weekly: WeeklyHoursApprovalMobile (phone) and
 * WeeklyCloseoutWizard (the desktop closeout modal). Extracted from the
 * mobile-only module (weekly-approval-mobile.ts, now a re-export shim) when
 * the desktop wizard landed — the band partition, ordinary/overtime split and
 * stepper queue are surface-agnostic projections, not phone code.
 *
 * The office (the boss) clears the crew's week one person at a time. This
 * module is the PROJECTION that shapes what those surfaces show — it never
 * fetches, never mutates, and never invents a number. It sits on top of the
 * SAME `buildWeeklyHoursCloseout` model the dense desktop board uses, so the
 * surfaces can never disagree.
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

/**
 * The ordinary / overtime split across a worker's APPROVED days only — the
 * hours a Xero push actually carries.
 *
 * Distinct from `workerOrdOtSplit`, which spans the whole logged week: on a
 * mixed week (some days approved, some rejected or still draft) the week-wide
 * figure overstates what is being sent. Same trap `submittedHoursOf` exists to
 * avoid for the approve button, so the pairing here is
 * `approvedOrdOtSplit` ↔ `approvedHours`.
 */
export function approvedOrdOtSplit(worker: WeeklyWorkerHours): WorkerOrdOt {
  let overtime = 0;
  let logged = 0;
  for (const d of worker.days) {
    if (d.status !== "approved") continue;
    if (d.hours != null) logged += d.hours;
    if (d.overtimeHours != null && d.overtimeHours > 0) overtime += d.overtimeHours;
  }
  overtime = round2(overtime);
  return { ordinary: round2(Math.max(0, logged - overtime)), overtime, hasOvertime: overtime > 0 };
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

/* ── Desktop closeout wizard (lean-reset redesign) ──────────────────────── */

/**
 * The worker ids the DESKTOP closeout wizard steps through — the WHOLE crew in
 * model order (needs-review → needs-worker → missing-hours → payroll-ready,
 * name-sorted within each band). Unlike the phone's `reviewQueueIds` (only the
 * to-approve band), the desktop ritual walks every week: weeks with nothing
 * submitted get a "Next" step so the boss still eyeballs the missing / sent-
 * back / already-approved ones before the payroll run.
 */
export function weeklyReviewQueue(closeout: WeeklyHoursCloseout): string[] {
  return closeout.workers.map((w) => w.workerId);
}

/**
 * Site-language status word under the wizard's name line ("Sparky · 2 days to
 * approve"). Priority: sent-back first (the office caused it, it needs the
 * worker), then approvable days, then the honest nothing-logged / draft /
 * missing states, then settled. Never invents a state the counts can't back.
 */
export function workerStatusWord(worker: WeeklyWorkerHours): string {
  if (worker.rejectedCount > 0) {
    return worker.rejectedCount === 1
      ? "A day was sent back"
      : `${worker.rejectedCount} days were sent back`;
  }
  if (worker.submittedCount > 0) {
    return `${worker.submittedCount} ${worker.submittedCount === 1 ? "day" : "days"} to approve`;
  }
  if (worker.loggedHours === 0) return "No hours logged this week";
  if (worker.draftCount > 0) return "A day is still a draft";
  if (worker.missingCount > 0) return "Missing a day";
  return "Already approved";
}

/**
 * The default reason stamped on a wizard send-back when the boss types no
 * note. The reject endpoint REQUIRES a reason (it 400s on empty) and the
 * worker reads it in a push — so the fallback must carry meaning on its own.
 */
export const CLOSEOUT_DEFAULT_REJECT_REASON =
  "Sent back from the weekly closeout — please check the day and re-submit.";

/** The reject reason the wizard sends: the trimmed note, or the default. */
export function closeoutRejectReason(note?: string): string {
  const trimmed = (note ?? "").trim();
  return trimmed.length > 0 ? trimmed : CLOSEOUT_DEFAULT_REJECT_REASON;
}

export interface ReviewDayRow {
  day: WeeklyHoursDay;
  /** Site-language note for an UNLOGGED day ("Missing", "Not on", "Not yet",
   *  "On leave · sick", the holiday's name) — null when the day has an entry
   *  (the row then shows the real jobs + hours instead). Never a fake 0. */
  note: string | null;
}

/**
 * The wizard's "Day by day" rows: every weekday, plus any weekend day
 * something real happened on (an entry or a server-flagged missing day —
 * mirrors the board's weekend filter). Unlogged days carry an honest note.
 */
export function reviewDayRows(worker: WeeklyWorkerHours): ReviewDayRow[] {
  return worker.days
    .filter(
      (d) =>
        !(["Sat", "Sun"].includes(d.weekday) && d.entryId === null && d.status !== "missing"),
    )
    .map((day) => ({ day, note: day.entryId ? null : unloggedDayNote(day) }));
}

function unloggedDayNote(day: WeeklyHoursDay): string {
  switch (day.status) {
    case "missing":
      return "Missing";
    case "future":
      return "Not yet";
    case "leave":
      return day.leaveType ? `On leave · ${day.leaveType}` : "On leave";
    case "holiday":
      return day.holidayName ?? "Public holiday";
    default:
      return "Not on";
  }
}
