import type { Job } from "@/domains/jobs/types";

/**
 * Where a cross-job queue card should point. When exactly one job carries
 * the whole count, deep-link to that job's section so the owner is one
 * click from the work; otherwise fall back to the jobs index.
 */
export function singleJobTarget(
  jobsAffected: ReadonlyArray<Job>,
  section: "evidence"
): { href: string; cta: string } {
  if (jobsAffected.length === 1) {
    return {
      href: `/v2/jobs/${encodeURIComponent(jobsAffected[0]!.id)}/${section}`,
      cta: "Open evidence",
    };
  }
  return { href: "/v2/jobs", cta: "Open jobs" };
}
