import {
  JOB_PHASE_OPTIONS,
  jobPhase,
  parseJobPhaseParam,
  phaseLabel,
  type JobPhase,
} from "./lifecycle";
import type { Job, JobStatus } from "./types";

/**
 * Pure filtering for the admin jobs index (/v2/jobs) — issue #216.
 *
 * The list stays client-side over the already-loaded jobs array (5–20 active
 * jobs per admin); these helpers exist so JobsList renders from the URL
 * (`?status=` + `?q=`) instead of ad-hoc component state, and so the filter
 * matrix is unit-testable without rendering.
 *
 * The pills filter by lifecycle PHASE (src/domains/jobs/lifecycle.ts), not the
 * raw status: a `complete` job is "Finished" inside its callback window and
 * "Closed" after, and the office needs those apart. A legacy job with no
 * `status` field is active (the same fallback the labels use).
 *
 * Cross-ref:
 *   src/components/admin/JobsList.tsx — the consumer
 *   src/domains/jobs/format.ts — JOB_STATUS_OPTIONS / statusLabel / statusTone
 */

export interface JobsListFilter {
  /** null = the working portfolio (no `?status=` param): active, on hold,
   *  finishing and draft — never closed or archived history. */
  status: JobPhase | null;
  /** Trimmed contains-match over name / address / ref / IV code. "" = no search. */
  query: string;
}

/**
 * Validate a raw `?status=` param (or a remembered value) against the real
 * status set from format.ts. Anything unknown → null (treated as "all"),
 * so stale deep links and stale stored defaults degrade silently.
 */
export function parseJobStatusParam(raw: string | null | undefined): JobPhase | null {
  // "complete" was a pill before the lifecycle split it in two; an old
  // bookmark or remembered filter lands on the closed history view.
  if (raw === "complete") return "closed";
  return parseJobPhaseParam(raw);
}

/** The status a job filters under — format.ts's "no status displays Active" rule. */
export function effectiveJobStatus(job: Pick<Job, "status">): JobStatus {
  return job.status ?? "active";
}

function matchesQuery(job: Job, q: string): boolean {
  const name = job.name.toLowerCase();
  const address = (job.siteAddress ?? "").toLowerCase();
  const ref = (job.ref ?? "").toLowerCase();
  // The IV#### job code is how the office and crew actually name a job
  // ("IV2041") — searching it must find the job even when name/ref don't carry it.
  const code = (job.code ?? "").toLowerCase();
  return name.includes(q) || address.includes(q) || ref.includes(q) || code.includes(q);
}

/** Archived jobs are out of the working portfolio — only the Archived view shows them. */
export function isArchivedJob(job: Pick<Job, "status">): boolean {
  return effectiveJobStatus(job) === "archived";
}

/** History = closed (finished, callback window over) or archived. Out of the
 *  working portfolio: not under "All", not in the header counts. */
export function isHistoryJob(job: Pick<Job, "status" | "completedAt">, now?: Date | string): boolean {
  const phase = jobPhase(job, now);
  return phase === "closed" || phase === "archived";
}

/**
 * Server-side trim for /v2/jobs: archived rows are only shipped to the list
 * when the request asks for the Archived view (`?status=archived`). Every
 * other view gets the working portfolio only, so archived jobs never leak into
 * "All", the pill counts or the portfolio header.
 */
export function jobsForStatusView(
  jobs: ReadonlyArray<Job>,
  status: JobPhase | null
): ReadonlyArray<Job> {
  if (status === "archived") return jobs;
  return jobs.filter((j) => !isArchivedJob(j));
}

/**
 * Apply status + search together. Pure; never mutates the input array.
 * "All" (status null) means all WORKING jobs — archived rows only appear under
 * the explicit Archived filter, even when the loaded list carries them (the
 * archived view's pills switch client-side without a refetch).
 */
export function filterJobs(
  jobs: ReadonlyArray<Job>,
  filter: JobsListFilter
): ReadonlyArray<Job> {
  const q = filter.query.trim().toLowerCase();
  return jobs.filter((job) => {
    if (filter.status && jobPhase(job) !== filter.status) return false;
    if (!filter.status && isHistoryJob(job)) return false;
    if (q && !matchesQuery(job, q)) return false;
    return true;
  });
}

/**
 * Per-status counts over the loaded list. Drives which pills render (statuses
 * with zero jobs stay hidden unless deep-linked — a permanently-empty pill
 * would imply data this page deliberately excludes, e.g. archived rows).
 */
export function jobStatusCounts(jobs: ReadonlyArray<Job>): ReadonlyMap<JobPhase, number> {
  const counts = new Map<JobPhase, number>();
  for (const job of jobs) {
    const s = jobPhase(job);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return counts;
}

/** The pills, in display order — phases, so Finished and Closed are apart. */
export const JOB_LIST_PHASE_OPTIONS = JOB_PHASE_OPTIONS;

/**
 * Filter-aware empty-state copy — names the active narrowing instead of a
 * bare "nothing here" (issue #216 AC). Only meaningful when the unfiltered
 * list is non-empty (the page-level zero-jobs empty state handles the rest).
 */
export function jobsEmptyStateMessage(filter: JobsListFilter): string {
  const q = filter.query.trim();
  const statusPart = filter.status ? phaseLabel(filter.status).toLowerCase() : null;
  if (statusPart && q) {
    return `No ${statusPart} jobs match “${q}”. Try a different search or status.`;
  }
  if (statusPart) {
    return `No ${statusPart} jobs in this list. Try a different status.`;
  }
  if (q) {
    return `No jobs match “${q}”. Try a different search term.`;
  }
  return "No jobs to show.";
}
