import type { WeeklyWorkerHours } from "./weekly-closeout";

/**
 * Pure helpers for pay-period payroll DOWNLOADS (#126 / #895).
 *
 * The committed run is retired: the only path that records a payroll run is the
 * immutable batch flow (create → validate → lock → export). What remains here
 * is the read-only dry-run PREVIEW URL and a readiness helper.
 *
 * The endpoint's DEFAULT range is computed in server-local time (UTC on Vercel)
 * — on a Sydney Monday morning that's *last* week. Every URL this builder emits
 * therefore carries explicit fromDate/toDate from the board's BUSINESS_TIMEZONE
 * week. There is deliberately no overload that omits them.
 */

export interface PayrollExportRange {
  /** YYYY-MM-DD, the board's week (BUSINESS_TIMEZONE Monday). */
  fromDate: string;
  /** YYYY-MM-DD, the board's week end (Sunday). */
  toDate: string;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function assertRange(range: PayrollExportRange): void {
  if (!ISO_DAY.test(range.fromDate) || !ISO_DAY.test(range.toDate)) {
    throw new Error("payroll export needs explicit YYYY-MM-DD fromDate/toDate");
  }
}

/** Dry-run preview URL (JSON, never stamps). */
export function payrollPreviewUrl(range: PayrollExportRange): string {
  assertRange(range);
  return (
    `/api/time-entries-export?dryRun=1&format=json` +
    `&fromDate=${encodeURIComponent(range.fromDate)}&toDate=${encodeURIComponent(range.toDate)}`
  );
}

/**
 * Workers the closeout says aren't payroll-ready — named alongside the batch
 * flow so "exported Thursday, Friday approved later" stops being a surprise.
 * Readiness is the board's own banding; this just filters it.
 */
export function notPayrollReadyWorkers(
  workers: ReadonlyArray<Pick<WeeklyWorkerHours, "workerName" | "readiness">>,
): string[] {
  return workers.filter((w) => w.readiness !== "payroll-ready").map((w) => w.workerName);
}
