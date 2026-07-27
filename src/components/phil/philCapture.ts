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

/**
 * The recent jobs a long-press of the FAB should offer as one-tap capture
 * destinations (#146). Recents come from #145's `readJobListPrefs(userId)`
 * (most-recent-first), but a stored id can be STALE — a job the worker was
 * un-assigned from, or one since archived. Such a recent must be dropped here:
 * offering it would deep-link a capture against a job the worker can no longer
 * see (a 403 on the job page). So we intersect the remembered ids with the
 * worker's actually-launchable jobs (assigned + non-archived; `launchableJobs`),
 * preserve recency order, and cap to a thumb-reachable shortlist.
 *
 * Pure (no fetch, no render) so the stale/cap/order rules are unit-tested. When
 * the result is empty the FAB long-press shows NO sheet — the caller falls
 * through to the plain camera tap (P7: never a fabricated recent).
 */
export function recentShortcutJobs(
  recentIds: ReadonlyArray<string>,
  launchable: ReadonlyArray<LaunchableJob>,
  max = 3,
): LaunchableJob[] {
  const byId = new Map(launchable.map((j) => [j.id, j]));
  const out: LaunchableJob[] = [];
  const seen = new Set<string>();
  for (const id of recentIds) {
    if (out.length >= max) break;
    if (seen.has(id)) continue;
    const job = byId.get(id);
    if (!job) continue; // stale: un-assigned or archived → dropped
    seen.add(id);
    out.push(job);
  }
  return out;
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
 * The job-page capture deep link (`?capture=<token>`). A fresh token each
 * call (defaults to now) so the detail page re-opens its capture sheet even
 * for a repeat launch. The v2 camera-first launcher no longer generates this
 * link (it submits the batch itself), but PhilJobDetail still honours it —
 * kept as the canonical builder for any other entry point.
 */
export function captureHref(jobId: string, token: number = Date.now()): string {
  return `/phil/jobs/${encodeURIComponent(jobId)}?capture=${token}`;
}

/**
 * Which job the camera-first capture should preselect as the destination:
 * the job home the FAB was tapped on (when it's actually launchable), else
 * the worker's only job, else none — a worker with multiple jobs makes an
 * explicit choice, never a guessed one.
 */
export function preselectCaptureJob(
  jobs: ReadonlyArray<LaunchableJob>,
  initialJobId: string | null | undefined,
): string | null {
  if (initialJobId && jobs.some((j) => j.id === initialJobId)) return initialJobId;
  if (jobs.length === 1) return jobs[0]!.id;
  return null;
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
