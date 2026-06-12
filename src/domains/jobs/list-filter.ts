import { JOB_STATUS_OPTIONS, statusLabel } from "./format";
import type { Job, JobStatus } from "./types";

/**
 * Pure filtering for the admin jobs index (/v2/jobs) — issue #216.
 *
 * The list stays client-side over the already-loaded jobs array (5–20 active
 * jobs per admin); these helpers exist so JobsList renders from the URL
 * (`?status=` + `?q=`) instead of ad-hoc component state, and so the filter
 * matrix is unit-testable without rendering.
 *
 * Status semantics mirror src/domains/jobs/format.ts exactly: a legacy job
 * with no `status` field displays as "Active" (statusLabel fallback), so the
 * filter MUST treat it as active too — otherwise a row labelled Active would
 * vanish under the Active pill.
 *
 * Cross-ref:
 *   src/components/admin/JobsList.tsx — the consumer
 *   src/domains/jobs/format.ts — JOB_STATUS_OPTIONS / statusLabel / statusTone
 */

export interface JobsListFilter {
  /** null = all statuses (no `?status=` param). */
  status: JobStatus | null;
  /** Trimmed contains-match over name / address / ref. "" = no search. */
  query: string;
}

/**
 * Validate a raw `?status=` param (or a remembered value) against the real
 * status set from format.ts. Anything unknown → null (treated as "all"),
 * so stale deep links and stale stored defaults degrade silently.
 */
export function parseJobStatusParam(raw: string | null | undefined): JobStatus | null {
  if (!raw) return null;
  return (JOB_STATUS_OPTIONS as ReadonlyArray<string>).includes(raw)
    ? (raw as JobStatus)
    : null;
}

/** The status a job filters under — format.ts's "no status displays Active" rule. */
export function effectiveJobStatus(job: Pick<Job, "status">): JobStatus {
  return job.status ?? "active";
}

function matchesQuery(job: Job, q: string): boolean {
  const name = job.name.toLowerCase();
  const address = (job.siteAddress ?? "").toLowerCase();
  const ref = (job.ref ?? "").toLowerCase();
  return name.includes(q) || address.includes(q) || ref.includes(q);
}

/** Apply status + search together. Pure; never mutates the input array. */
export function filterJobs(
  jobs: ReadonlyArray<Job>,
  filter: JobsListFilter
): ReadonlyArray<Job> {
  const q = filter.query.trim().toLowerCase();
  return jobs.filter((job) => {
    if (filter.status && effectiveJobStatus(job) !== filter.status) return false;
    if (q && !matchesQuery(job, q)) return false;
    return true;
  });
}

/**
 * Per-status counts over the loaded list. Drives which pills render (statuses
 * with zero jobs stay hidden unless deep-linked — a permanently-empty pill
 * would imply data this page deliberately excludes, e.g. archived rows).
 */
export function jobStatusCounts(jobs: ReadonlyArray<Job>): ReadonlyMap<JobStatus, number> {
  const counts = new Map<JobStatus, number>();
  for (const job of jobs) {
    const s = effectiveJobStatus(job);
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return counts;
}

/**
 * Filter-aware empty-state copy — names the active narrowing instead of a
 * bare "nothing here" (issue #216 AC). Only meaningful when the unfiltered
 * list is non-empty (the page-level zero-jobs empty state handles the rest).
 */
export function jobsEmptyStateMessage(filter: JobsListFilter): string {
  const q = filter.query.trim();
  const statusPart = filter.status ? statusLabel(filter.status).toLowerCase() : null;
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
