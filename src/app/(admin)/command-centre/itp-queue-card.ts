import type { Job } from "@/domains/jobs/types";

/**
 * Helper for the "ITPs needing sign-off" queue card on /command-centre.
 *
 * Pure derivation from the `/api/jobs?withStats=1` list: counts the
 * witnessed-only subset (`statsItpsNeedsReview`) across visible jobs,
 * the number of jobs affected, and picks the right link target.
 *
 * - Single affected job → deep link to /v2/jobs/<jobId>/itps so the
 *   admin lands on the sign-off queue with one click.
 * - Multiple jobs → /v2/jobs (admin jobs index, ITP chip visible).
 * - Zero jobs → /v2/jobs (same default as the existing snags + evidence
 *   cards in the empty state — clicking the empty card still surfaces
 *   the jobs index).
 *
 * Why a separate helper: the page component is server-only and async;
 * pulling this derivation out keeps the derivation pure + unit-testable
 * without rendering the full server tree.
 *
 * Cross-ref:
 *   docs/rebuild-audit/phase-e1-itp-runbook.md §15 — recommended PR
 *   src/app/(admin)/command-centre/page.tsx — sole consumer
 *   api/jobs.js — statsItpsNeedsReview source of truth
 */

export interface ItpQueueSummary {
  /** Total witnessed-but-not-signed-off ITP instances across jobs. */
  count: number;
  /** Number of jobs with at least one witnessed instance. */
  jobsAffected: number;
  /** Link target — single job deep-links to the queue, multi falls back. */
  href: string;
}

export function summariseItpReviewQueue(
  jobs: ReadonlyArray<Job>,
): ItpQueueSummary {
  let count = 0;
  const affectedIds: string[] = [];
  for (const j of jobs) {
    const n = j.statsItpsNeedsReview ?? 0;
    if (n > 0) {
      count += n;
      affectedIds.push(j.id);
    }
  }
  const jobsAffected = affectedIds.length;
  // Single affected job → deep link; multi or none → /v2/jobs.
  const href =
    jobsAffected === 1
      ? `/v2/jobs/${encodeURIComponent(affectedIds[0]!)}/itps`
      : "/v2/jobs";
  return { count, jobsAffected, href };
}
