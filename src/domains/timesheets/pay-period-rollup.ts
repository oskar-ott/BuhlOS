/**
 * Pay-period roll-up — the pure core of the "Xero-ready payroll preview" (#131),
 * the BuhlOS side of the payroll boundary ([payroll-boundary-adr] #609).
 *
 * Closeout is weekly (`/hours/weekly`), but pay runs and money questions span
 * periods (fortnightly pay, "how many hours did we pay last month?"). This
 * aggregator answers them by rolling the EXISTING approved export rows up by
 * worker across an arbitrary date range — per-worker totals, the
 * ordinary/overtime split, and the two pre-push payroll facts the office needs:
 * which approved hours are NOT yet in a committed run, and which workers have no
 * Xero employee id yet.
 *
 * NO SECOND ENGINE. The rows this consumes are exactly the dry-run output of
 * `api/time-entries-export.js` (`?dryRun=1&format=json`): the ordinary/overtime
 * split and the #380 multi-allocation proration are already computed there, the
 * one authoritative place. This file only groups and sums — it never re-derives
 * a split, re-attributes overtime, or invents a work type that has no data
 * source (travel/allowance/earnings-rate ids are deferred to #129/#611 + the
 * Xero connection; building buckets for them now would be fake UI, P7).
 *
 * Approved-only by design: the preview is the payroll-ready slice, so only
 * `status === "approved"` rows contribute to totals — exactly like the committed
 * export, which pins `status=approved` and must never widen.
 */

/** Minimal slice of one `api/time-entries-export.js` JSON row this consumes. */
export interface PayPeriodSourceRow {
  workerId: string;
  workerName: string;
  /** Monday (BUSINESS_TIMEZONE) of the row's week — emitted by the export. */
  weekStart: string;
  /** YYYY-MM-DD of the worked day. */
  date: string;
  hours: number;
  ordinaryHours: number;
  overtimeHours: number;
  /** "approved" | "submitted" | "rejected" | "draft" — only approved counts. */
  status: string;
  /** Committed-run id when the day is already stamped; "" / absent otherwise. */
  exportId?: string;
  /** Worker's Xero employee id; "" / absent when not yet mapped. */
  xeroEmployeeId?: string;
  /** Optional display role, when the caller joined it. */
  workerRole?: string | null;
}

/** Per-week sub-total inside a worker's period roll-up. */
export interface PayPeriodWeekSlice {
  /** Monday of the week. */
  weekStart: string;
  approvedHours: number;
  ordinaryHours: number;
  overtimeHours: number;
}

export interface PayPeriodWorker {
  workerId: string;
  workerName: string;
  workerRole: string | null;
  /** Total APPROVED hours in the period. */
  approvedHours: number;
  ordinaryHours: number;
  overtimeHours: number;
  /** Approved hours not yet stamped into a committed payroll run. */
  unexportedApprovedHours: number;
  /** Distinct dates with an approved entry (a split day counts once). */
  approvedDayCount: number;
  /** True when the worker carries a non-empty Xero employee id today. */
  xeroMapped: boolean;
  /** Per-week sub-totals, Monday-sorted. */
  weeks: PayPeriodWeekSlice[];
}

export interface PayPeriodRollup {
  fromDate: string;
  toDate: string;
  /** Workers with approved hours in the period, name-sorted. */
  workers: PayPeriodWorker[];
  summary: {
    workerCount: number;
    approvedHours: number;
    ordinaryHours: number;
    overtimeHours: number;
    unexportedApprovedHours: number;
    /** Workers with approved hours but no Xero employee id — the pre-mapping
     *  blocker the office must clear before a push ([#248]). */
    unmappedWorkerCount: number;
  };
}

export interface PayPeriodRange {
  /** YYYY-MM-DD inclusive. */
  fromDate: string;
  /** YYYY-MM-DD inclusive. */
  toDate: string;
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function hasId(v: string | undefined | null): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

interface WorkerAccum {
  workerId: string;
  workerName: string;
  workerRole: string | null;
  approvedHours: number;
  ordinaryHours: number;
  overtimeHours: number;
  unexportedApprovedHours: number;
  approvedDates: Set<string>;
  xeroMapped: boolean;
  weeks: Map<string, { approvedHours: number; ordinaryHours: number; overtimeHours: number }>;
}

/**
 * Roll approved export rows up by worker across [fromDate, toDate].
 *
 * Pure and order-independent: multiple rows for one worker-day (a split day
 * emits one row per allocation) sum into the same worker, and the day is counted
 * once. Non-approved rows are ignored. The range is carried through for display
 * and is NOT used to re-filter — pass rows already scoped to the period.
 */
export function buildPayPeriodRollup(
  rows: ReadonlyArray<PayPeriodSourceRow>,
  range: PayPeriodRange,
): PayPeriodRollup {
  const byWorker = new Map<string, WorkerAccum>();

  for (const row of rows) {
    if (row.status !== "approved") continue;

    let acc = byWorker.get(row.workerId);
    if (!acc) {
      acc = {
        workerId: row.workerId,
        workerName: row.workerName,
        workerRole: row.workerRole ?? null,
        approvedHours: 0,
        ordinaryHours: 0,
        overtimeHours: 0,
        unexportedApprovedHours: 0,
        approvedDates: new Set<string>(),
        xeroMapped: false,
        weeks: new Map(),
      };
      byWorker.set(row.workerId, acc);
    }

    const hours = Number(row.hours) || 0;
    const ordinary = Number(row.ordinaryHours) || 0;
    const overtime = Number(row.overtimeHours) || 0;

    acc.approvedHours += hours;
    acc.ordinaryHours += ordinary;
    acc.overtimeHours += overtime;
    acc.approvedDates.add(row.date);
    if (!hasId(row.exportId)) acc.unexportedApprovedHours += hours;
    if (hasId(row.xeroEmployeeId)) acc.xeroMapped = true;

    const wk = acc.weeks.get(row.weekStart) ?? {
      approvedHours: 0,
      ordinaryHours: 0,
      overtimeHours: 0,
    };
    wk.approvedHours += hours;
    wk.ordinaryHours += ordinary;
    wk.overtimeHours += overtime;
    acc.weeks.set(row.weekStart, wk);
  }

  const workers: PayPeriodWorker[] = [...byWorker.values()]
    .map((acc) => ({
      workerId: acc.workerId,
      workerName: acc.workerName,
      workerRole: acc.workerRole,
      approvedHours: round2(acc.approvedHours),
      ordinaryHours: round2(acc.ordinaryHours),
      overtimeHours: round2(acc.overtimeHours),
      unexportedApprovedHours: round2(acc.unexportedApprovedHours),
      approvedDayCount: acc.approvedDates.size,
      xeroMapped: acc.xeroMapped,
      weeks: [...acc.weeks.entries()]
        .map(([weekStart, w]) => ({
          weekStart,
          approvedHours: round2(w.approvedHours),
          ordinaryHours: round2(w.ordinaryHours),
          overtimeHours: round2(w.overtimeHours),
        }))
        .sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
    }))
    .sort((a, b) => a.workerName.localeCompare(b.workerName) || a.workerId.localeCompare(b.workerId));

  const summary = workers.reduce(
    (s, w) => {
      s.approvedHours += w.approvedHours;
      s.ordinaryHours += w.ordinaryHours;
      s.overtimeHours += w.overtimeHours;
      s.unexportedApprovedHours += w.unexportedApprovedHours;
      if (!w.xeroMapped) s.unmappedWorkerCount += 1;
      return s;
    },
    {
      workerCount: workers.length,
      approvedHours: 0,
      ordinaryHours: 0,
      overtimeHours: 0,
      unexportedApprovedHours: 0,
      unmappedWorkerCount: 0,
    },
  );

  return {
    fromDate: range.fromDate,
    toDate: range.toDate,
    workers,
    summary: {
      workerCount: summary.workerCount,
      approvedHours: round2(summary.approvedHours),
      ordinaryHours: round2(summary.ordinaryHours),
      overtimeHours: round2(summary.overtimeHours),
      unexportedApprovedHours: round2(summary.unexportedApprovedHours),
      unmappedWorkerCount: summary.unmappedWorkerCount,
    },
  };
}
