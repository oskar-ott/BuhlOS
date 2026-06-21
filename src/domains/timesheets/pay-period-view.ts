/**
 * Pure view helpers for the `/hours/period` admin surface (#131, increment 2).
 *
 * The page composes two EXISTING engines — never a third:
 *   - approved-hours totals come from `buildPayPeriodRollup` (#616) over the
 *     `api/time-entries-export.js` dry-run rows;
 *   - per-week readiness comes from `buildWeeklyHoursCloseout` (the same engine
 *     `/hours/weekly` uses), one closeout per Mon–Sun week in the period.
 *
 * This file only does the glue that is worth unit-testing: pay-period range
 * maths, week enumeration, defensive extraction of the export rows, and
 * folding the per-week closeouts into one period-level readiness signal.
 */
import { addDays, weekEndOf, weekStartOf } from "./service";
import type { PayPeriodSourceRow } from "./pay-period-rollup";
import type { WeeklyHoursCloseout } from "./weekly-closeout";

export type PayPeriodKind = "week" | "fortnight";

export interface PayPeriodRange {
  /** YYYY-MM-DD (Monday). */
  fromDate: string;
  /** YYYY-MM-DD (Sunday). */
  toDate: string;
}

/**
 * The range for a `week` or `fortnight` ending in the anchor's Mon–Sun week.
 * `anchorISO` is any date inside the LAST week of the period (nav passes a
 * Monday). A fortnight is the anchor's week plus the week before it.
 */
export function payPeriodRangeFor(kind: PayPeriodKind, anchorISO: string): PayPeriodRange {
  const weeks = kind === "fortnight" ? 2 : 1;
  const toDate = weekEndOf(anchorISO);
  const fromDate = addDays(weekStartOf(anchorISO), -7 * (weeks - 1));
  return { fromDate, toDate };
}

/** Step one period backward/forward — for the prev/next nav. `dir` is ±1. */
export function shiftAnchor(kind: PayPeriodKind, anchorISO: string, dir: number): string {
  const span = kind === "fortnight" ? 14 : 7;
  return weekStartOf(addDays(weekStartOf(anchorISO), span * dir));
}

/** The Monday of every Mon–Sun week overlapping [fromDate, toDate]. */
export function payPeriodWeekStarts(range: PayPeriodRange): string[] {
  const out: string[] = [];
  let monday = weekStartOf(range.fromDate);
  const last = weekStartOf(range.toDate);
  // Guard against a malformed (reversed) range — never loop forever.
  let safety = 0;
  while (monday <= last && safety < 60) {
    out.push(monday);
    monday = addDays(monday, 7);
    safety += 1;
  }
  return out;
}

/** True for a well-formed inclusive YYYY-MM-DD range with from ≤ to. */
export function isValidRange(fromDate: string, toDate: string): boolean {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  return iso.test(fromDate) && iso.test(toDate) && fromDate <= toDate;
}

/**
 * Defensively extract the rows we need from the `time-entries-export` JSON
 * response (`{ range, rows, summary }`). Unknown/malformed shapes yield `[]`
 * so the caller renders an honest empty/error state, never a crash.
 */
export function toPayPeriodRows(json: unknown): PayPeriodSourceRow[] {
  if (!json || typeof json !== "object") return [];
  const rows = (json as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return [];
  const out: PayPeriodSourceRow[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    if (typeof row.workerId !== "string" || typeof row.date !== "string") continue;
    out.push({
      workerId: row.workerId,
      workerName: typeof row.workerName === "string" ? row.workerName : row.workerId,
      weekStart: typeof row.weekStart === "string" ? row.weekStart : "",
      date: row.date,
      hours: Number(row.hours) || 0,
      ordinaryHours: Number(row.ordinaryHours) || 0,
      overtimeHours: Number(row.overtimeHours) || 0,
      status: typeof row.status === "string" ? row.status : "",
      exportId: typeof row.exportId === "string" ? row.exportId : "",
      xeroEmployeeId: typeof row.xeroEmployeeId === "string" ? row.xeroEmployeeId : "",
    });
  }
  return out;
}

export interface PeriodReadiness {
  weeksTotal: number;
  weeksReady: number;
  /** Every week in the period is payroll-ready. */
  fullyClosed: boolean;
  /** Distinct workers not payroll-ready in at least one week of the period. */
  workersNeedingAction: number;
}

/** Fold the per-week closeouts into one period-level readiness summary. */
export function summarisePeriodReadiness(
  closeouts: ReadonlyArray<WeeklyHoursCloseout>,
): PeriodReadiness {
  let weeksReady = 0;
  const needAction = new Set<string>();
  for (const c of closeouts) {
    if (c.summary.payrollReady) weeksReady += 1;
    for (const w of c.workers) {
      if (w.readiness !== "payroll-ready") needAction.add(w.workerId);
    }
  }
  return {
    weeksTotal: closeouts.length,
    weeksReady,
    fullyClosed: closeouts.length > 0 && weeksReady === closeouts.length,
    workersNeedingAction: needAction.size,
  };
}

export interface WorkerAction {
  needsAction: boolean;
  /** How many weeks in the period this worker is not payroll-ready. */
  blockingWeeks: number;
}

/** Per-worker action signal across the period, keyed by workerId. */
export function workerActionMap(
  closeouts: ReadonlyArray<WeeklyHoursCloseout>,
): Map<string, WorkerAction> {
  const map = new Map<string, WorkerAction>();
  for (const c of closeouts) {
    for (const w of c.workers) {
      const prev = map.get(w.workerId) ?? { needsAction: false, blockingWeeks: 0 };
      if (w.readiness !== "payroll-ready") {
        prev.needsAction = true;
        prev.blockingWeeks += 1;
      }
      map.set(w.workerId, prev);
    }
  }
  return map;
}
