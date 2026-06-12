import type { WeeklyWorkerHours } from "./weekly-closeout";

/**
 * Pure helpers for the committed payroll export on /hours/weekly (#126).
 *
 * THE TWO TRAPS this file exists to guard (see the issue's audit brief):
 *
 * 1. The committed run is a MUTATING GET (it stamps entries + appends the
 *    runs log). It must never be a <Link>/<a> Next could prefetch — callers
 *    navigate programmatically (window.location) so the browser handles the
 *    Content-Disposition download, and confirm success by re-reading
 *    /api/payroll-runs (the X-Export-Id header is invisible to navigation).
 *
 * 2. The endpoint's DEFAULT range is computed in server-local time (UTC on
 *    Vercel) — on a Sydney Monday morning that's *last* week. Every URL this
 *    builder emits therefore carries explicit fromDate/toDate from the
 *    board's BUSINESS_TIMEZONE week. There is deliberately no overload that
 *    omits them.
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
 * The COMMITTED run URL (CSV download; stamps entries, appends the runs
 * log). Mutating GET — navigate to it, never fetch/prefetch/render as a
 * link. Status is pinned to approved: the committed run must never widen.
 */
export function payrollCommitUrl(range: PayrollExportRange): string {
  assertRange(range);
  return (
    `/api/time-entries-export?status=approved` +
    `&fromDate=${encodeURIComponent(range.fromDate)}&toDate=${encodeURIComponent(range.toDate)}`
  );
}

/** Minimal preview-row slice the readiness checks consume. */
export interface PayrollPreviewRowLike {
  date: string;
  workerName: string;
  exportId?: string;
}

export interface AlreadyExportedSummary {
  rowCount: number;
  /** Distinct prior run ids these rows were stamped with. */
  exportIds: string[];
}

/**
 * Rows in the preview that already carry an exportId — i.e. a committed run
 * already included them. The endpoint does NOT refuse re-export (it re-stamps
 * with the new run's id), so the UI's confirm step is the guard: blocking by
 * default, explicit "export anyway" acknowledgement to proceed.
 */
export function summariseAlreadyExported(
  rows: ReadonlyArray<PayrollPreviewRowLike>,
): AlreadyExportedSummary {
  const ids = new Set<string>();
  let rowCount = 0;
  for (const row of rows) {
    if (row.exportId) {
      rowCount += 1;
      ids.add(row.exportId);
    }
  }
  return { rowCount, exportIds: [...ids].sort() };
}

/**
 * Workers the closeout says aren't payroll-ready — named in the commit
 * confirm so "exported Thursday, Friday approved later" stops being a
 * surprise. Readiness is the board's own banding; this just filters it.
 */
export function notPayrollReadyWorkers(
  workers: ReadonlyArray<Pick<WeeklyWorkerHours, "workerName" | "readiness">>,
): string[] {
  return workers.filter((w) => w.readiness !== "payroll-ready").map((w) => w.workerName);
}
