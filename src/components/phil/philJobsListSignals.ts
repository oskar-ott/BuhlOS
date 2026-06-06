import type { Job } from "@/domains/jobs/types";

/**
 * "Open work on this site" signals for a Phil jobs-list row.
 *
 * Derived ONLY from the real, opt-in stats the list endpoint returns with
 * `?withStats=1` (computeJobStats in api/jobs.js):
 *   - `statsSnagsV2Active` — snagsV2 in active states (open / in_progress /
 *     resolved-pending-verify), the same set the per-job Snags panel lists.
 *   - `statsItpsActive` — ITP instances in non-terminal, non-archived states,
 *     the same set the per-job ITPs panel lists.
 *
 * These are job-WIDE counts (a site-level "what's open here?" glance), not a
 * per-worker to-do list — the job screen's PhilJobAttentionStrip does the
 * scoped, personal attention. The label vocabulary + counts deliberately
 * match PhilJobAreaCard so the list and the job agree.
 *
 * Honest by construction:
 *   - A signal is emitted only when its count is a real positive integer.
 *   - When the stats are absent (endpoint called without `withStats`, or a
 *     soft-failed server read), every count is 0, so NO chips render and the
 *     row looks exactly as it did before — never a fabricated "all clear" or
 *     a guessed number.
 *   - Neutral nouns ("3 snags", "2 ITPs"), never "yours" / "to do", so an
 *     unscoped job-wide count is never dressed up as a personal task list.
 */
export type JobOpenWorkKey = "snags" | "itps";

export interface JobOpenWorkSignal {
  key: JobOpenWorkKey;
  count: number;
  /** Pre-pluralised, field-plain label, e.g. "1 snag" / "3 snags". */
  label: string;
}

export function jobOpenWork(
  job: Pick<Job, "statsSnagsV2Active" | "statsItpsActive">,
): JobOpenWorkSignal[] {
  const out: JobOpenWorkSignal[] = [];

  const snags = job.statsSnagsV2Active ?? 0;
  if (snags > 0) {
    out.push({
      key: "snags",
      count: snags,
      label: snags === 1 ? "1 snag" : `${snags} snags`,
    });
  }

  const itps = job.statsItpsActive ?? 0;
  if (itps > 0) {
    out.push({
      key: "itps",
      count: itps,
      label: itps === 1 ? "1 ITP" : `${itps} ITPs`,
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
