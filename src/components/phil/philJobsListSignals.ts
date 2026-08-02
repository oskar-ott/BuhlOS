import type { Job } from "@/domains/jobs/types";

/**
 * "Open work on this site" signals for a Phil jobs-list row.
 *
 * Derived ONLY from the real, opt-in stats the list endpoint returns with
 * `?withStats=1` (computeJobStats in api/jobs.js):
 *   - `statsSnagsV2Active` — snagsV2 in active states (open / in_progress /
 *     resolved-pending-verify), the same set the per-job Snags panel lists.
 *   (The ITP signal left with the ITP teardown — the job-page rebuild.)
 *
 * These are job-WIDE counts (a site-level "what's open here?" glance), not a
 * per-worker to-do list. The label vocabulary deliberately stays field-plain
 * so the list and the job agree.
 *
 * Honest by construction:
 *   - A signal is emitted only when its count is a real positive integer.
 *   - When the stats are absent (endpoint called without `withStats`, or a
 *     soft-failed server read), every count is 0, so NO chips render and the
 *     row looks exactly as it did before — never a fabricated "all clear" or
 *     a guessed number.
 *   - Neutral nouns ("3 snags"), never "yours" / "to do", so an unscoped
 *     job-wide count is never dressed up as a personal task list.
 */
export type JobOpenWorkKey = "snags";

export interface JobOpenWorkSignal {
  key: JobOpenWorkKey;
  count: number;
  /** Pre-pluralised, field-plain label, e.g. "1 snag" / "3 snags". */
  label: string;
}

function positiveInteger(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

export function jobOpenWork(
  job: Pick<Job, "statsSnagsV2Active">,
): JobOpenWorkSignal[] {
  const out: JobOpenWorkSignal[] = [];

  const snags = positiveInteger(job.statsSnagsV2Active);
  if (snags > 0) {
    out.push({
      key: "snags",
      count: snags,
      label: snags === 1 ? "1 snag" : `${snags} snags`,
    });
  }

  return out;
}

/** Screen-reader summary of the open-work signals, or null when there are
 *  none. Folded into the row's link label so the count is announced, not
 *  just shown. */
export function jobOpenWorkSummary(signals: ReadonlyArray<JobOpenWorkSignal>): string | null {
  if (signals.length === 0) return null;
  return signals.map((s) => s.label).join(", ");
}
