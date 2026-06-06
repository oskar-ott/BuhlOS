import type { TimeEntry } from "@/domains/timesheets/types";

/**
 * Pure per-job labour derivation for the admin Job hub Overview.
 *
 * Time entries are stored per-user-per-day (api/_lib/time-entries.js) with a
 * multi-job `allocations[]` array — there is NO per-job hours index. So a
 * per-job view sums the allocations that point at THIS job across whatever
 * entries the caller fetched.
 *
 * The hub's Labour card feeds this the approver-scope SUBMITTED queue
 * (GET /api/time-entries?scope=approver&status=submitted) — i.e. the hours
 * awaiting office approval — so the card is a read-only "what's waiting for me
 * to approve on this job" summary, NOT a total-logged ledger. The full ledger
 * (approved + rejected history, weekly totals, payroll export) lives on the
 * existing /hours/approvals surface and is a documented follow-up here.
 *
 * The summary is deliberately status-agnostic: it buckets by `entry.status`,
 * so the day a per-job hours endpoint (or a multi-status fetch) feeds it
 * approved / rejected entries too, the same helper yields the full breakdown
 * with no change to its callers.
 *
 * Strictly pure (no fetch, no React) and never fabricates: an entry with no
 * allocation on this job contributes nothing, and empty input yields an honest
 * zeroed summary with `hasAny: false`.
 *
 * Cross-ref:
 *   src/domains/jobs/attention.ts — sibling pure derivation (precedent)
 *   src/domains/timesheets/types.ts — TimeEntry / allocations shape
 *   src/components/admin/JobLabourSummary.tsx — the consumer
 */

export interface JobHoursSummary {
  jobId: string;
  /** Hours summed across every status bucket present in the input. */
  totalHours: number;
  /** status === "submitted" — awaiting office approval. */
  pendingHours: number;
  pendingCount: number;
  /** status === "approved". 0 unless the caller fed approved entries. */
  approvedHours: number;
  approvedCount: number;
  /** status === "rejected". 0 unless the caller fed rejected entries. */
  rejectedHours: number;
  rejectedCount: number;
  /** Distinct workers with hours on this job in the input. */
  workerCount: number;
  /** Newest entry date (YYYY-MM-DD) with hours on this job, or null. */
  latestDate: string | null;
  /** True when at least one entry carries hours on this job. */
  hasAny: boolean;
}

export interface JobWorkerHours {
  userId: string;
  userName: string;
  hours: number;
  entryCount: number;
}

/** Round to 2dp so float summation noise (7.6 + 0.0…1) never leaks to the UI. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Sum the hours an entry allocated to a single job. Allocations with a
 * different (or null) jobId, or a non-finite/negative hours value, contribute
 * nothing.
 */
export function hoursOnJob(entry: Pick<TimeEntry, "allocations">, jobId: string): number {
  if (!jobId || !Array.isArray(entry.allocations)) return 0;
  let sum = 0;
  for (const a of entry.allocations) {
    if (!a || a.jobId !== jobId) continue;
    const h = Number(a.hours);
    if (Number.isFinite(h) && h > 0) sum += h;
  }
  return round2(sum);
}

/**
 * Derive the per-job labour summary from a list of time entries. Only the
 * allocation hours pointing at `jobId` count; an entry split across jobs
 * contributes just its slice for this one.
 */
export function summariseJobHours(
  entries: ReadonlyArray<TimeEntry>,
  jobId: string,
): JobHoursSummary {
  const summary: JobHoursSummary = {
    jobId,
    totalHours: 0,
    pendingHours: 0,
    pendingCount: 0,
    approvedHours: 0,
    approvedCount: 0,
    rejectedHours: 0,
    rejectedCount: 0,
    workerCount: 0,
    latestDate: null,
    hasAny: false,
  };
  if (!Array.isArray(entries) || entries.length === 0) return summary;

  const workers = new Set<string>();
  let total = 0;
  let pending = 0;
  let approved = 0;
  let rejected = 0;

  for (const e of entries) {
    const h = hoursOnJob(e, jobId);
    if (h <= 0) continue;

    summary.hasAny = true;
    total += h;
    if (e.userId) workers.add(e.userId);
    if (typeof e.date === "string" && (!summary.latestDate || e.date > summary.latestDate)) {
      summary.latestDate = e.date;
    }

    switch (e.status) {
      case "submitted":
        pending += h;
        summary.pendingCount += 1;
        break;
      case "approved":
        approved += h;
        summary.approvedCount += 1;
        break;
      case "rejected":
        rejected += h;
        summary.rejectedCount += 1;
        break;
      // "draft" never reaches an approver scope; ignored if ever present.
    }
  }

  summary.totalHours = round2(total);
  summary.pendingHours = round2(pending);
  summary.approvedHours = round2(approved);
  summary.rejectedHours = round2(rejected);
  summary.workerCount = workers.size;
  return summary;
}

/**
 * Group the per-job hours by worker for the card's small breakdown. Sorted by
 * hours (desc) then name so the heaviest contributor reads first; ties stay
 * stable and alphabetical.
 */
export function groupJobHoursByWorker(
  entries: ReadonlyArray<TimeEntry>,
  jobId: string,
): JobWorkerHours[] {
  if (!Array.isArray(entries)) return [];
  const byWorker = new Map<string, JobWorkerHours>();

  for (const e of entries) {
    const h = hoursOnJob(e, jobId);
    if (h <= 0 || !e.userId) continue;
    const existing = byWorker.get(e.userId);
    if (existing) {
      existing.hours = round2(existing.hours + h);
      existing.entryCount += 1;
    } else {
      byWorker.set(e.userId, {
        userId: e.userId,
        userName: e.userName || e.userId,
        hours: h,
        entryCount: 1,
      });
    }
  }

  return [...byWorker.values()].sort(
    (a, b) => b.hours - a.hours || a.userName.localeCompare(b.userName),
  );
}

export interface JobHoursAttention {
  /** True when hours are awaiting office approval on this job. */
  pending: boolean;
  pendingHours: number;
  pendingCount: number;
}

/**
 * The single actionable signal for the office: are there hours waiting to be
 * approved on this job? Mirrors deriveJobAttention's "real, positive only"
 * discipline — nothing pending yields `pending: false`.
 */
export function deriveJobHoursAttention(summary: JobHoursSummary): JobHoursAttention {
  return {
    pending: summary.pendingCount > 0,
    pendingHours: summary.pendingHours,
    pendingCount: summary.pendingCount,
  };
}
