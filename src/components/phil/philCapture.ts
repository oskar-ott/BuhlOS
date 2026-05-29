import type { Job } from "@/domains/jobs/types";

/**
 * Pure helpers for the global Capture launcher (the centre FAB in
 * PhilTabBar). Kept out of the component so the "which jobs, and what to
 * do with them" decision is unit-testable without rendering.
 *
 * Cross-ref:
 *   src/components/phil/PhilCaptureLauncher.tsx — the consumer
 *   docs/rebuild-audit/29-phase-d3-phil-capture-spec.md §3 (capture flow)
 */

export interface LaunchableJob {
  id: string;
  name: string;
  siteAddress: string | null;
}

/**
 * Jobs the worker can capture against, in list order. Archived jobs are
 * dropped — the Phil jobs list hides them too, and a worker shouldn't be
 * pushed into capturing evidence against a job that's been closed out.
 */
export function launchableJobs(jobs: ReadonlyArray<Job>): LaunchableJob[] {
  return jobs
    .filter((j) => j.status !== "archived")
    .map((j) => ({
      id: j.id,
      name: j.name,
      siteAddress: j.siteAddress ?? null,
    }));
}

export type LauncherDecision =
  | { kind: "empty" }
  | { kind: "single"; job: LaunchableJob }
  | { kind: "choose"; jobs: LaunchableJob[] };

/**
 * What the launcher should do once the worker's jobs load:
 *   - none           → empty state ("ask your PM")
 *   - exactly one    → skip the picker, deep-link straight to capture
 *   - more than one  → show the picker
 *
 * Skipping the picker for the single-job case is the common tradie
 * reality (one site at a time) and saves a tap on a noisy site.
 */
export function launcherDecision(jobs: ReadonlyArray<Job>): LauncherDecision {
  const launchable = launchableJobs(jobs);
  if (launchable.length === 0) return { kind: "empty" };
  if (launchable.length === 1) return { kind: "single", job: launchable[0]! };
  return { kind: "choose", jobs: launchable };
}

/**
 * The deep link the launcher pushes. A fresh token each call (defaults to
 * now) so the detail page re-opens the capture sheet even when the worker
 * launches capture for the same job twice in a row.
 */
export function captureHref(jobId: string, token: number = Date.now()): string {
  return `/phil/jobs/${encodeURIComponent(jobId)}?capture=${token}`;
}

/**
 * The job id when the worker is on a single job's detail page
 * (/phil/jobs/<id>), else null. The global Capture button uses this to
 * decide between a direct deep-link (we already know the job, so capture
 * is one tap) and the job picker (we don't, so ask which job). Sub-routes
 * like /phil/jobs/<id>/itps/<x> intentionally return null — those aren't
 * the job home, so we fall back to the picker.
 */
export function philJobDetailId(pathname: string): string | null {
  const m = /^\/phil\/jobs\/([^/]+)$/.exec(pathname);
  return m ? decodeURIComponent(m[1]!) : null;
}
