import type { Job } from "./types";

/**
 * Pure "what needs office action on this job" derivation for the admin Job
 * hub Overview.
 *
 * The job hub already fetches `/api/jobs?id=&withStats=1`, whose response
 * carries real, blob-derived counts on the parsed `Job` (see
 * src/domains/jobs/schema.ts `stats*`). The Overview historically discarded
 * them; this helper turns the actionable subset into a small "Needs
 * attention" model the hub renders, deep-linking to the matching tab.
 *
 * It is deliberately pure (no fetch, no React) and only surfaces counts that
 * (a) are genuinely actionable for the office/PM and (b) have a per-job tab to
 * link to — evidence awaiting review, open snags, and ITPs awaiting sign-off.
 * Gear-tag expiry (`statsExpired/ExpiringTags`) is intentionally excluded: it
 * has no per-job destination and belongs on the Command Centre / Gear surface.
 *
 * NO fabricated numbers: a missing/zero/negative stat contributes nothing, so
 * "All clear" is only shown when the real counts are genuinely all zero.
 *
 * Cross-ref:
 *   src/components/admin/JobOverviewSummary.tsx — the consumer
 *   src/app/(admin)/command-centre/page.tsx — the cross-job attention surface
 *     this mirrors at the single-job level (does not replace it)
 */

export type JobAttentionKey = "evidence" | "snags" | "itps";

export interface JobAttentionItem {
  /** Also the per-job tab segment: /v2/jobs/<id>/<key>. */
  key: JobAttentionKey;
  label: string;
  count: number;
}

export interface JobAttention {
  items: JobAttentionItem[];
  /** True when nothing on the job needs office action right now. */
  allClear: boolean;
  /** Sum of all attention counts (0 when allClear). */
  total: number;
}

/** A real, positive count or 0 — never a fabricated number. */
function positive(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Derive the job's "needs attention" model from the real stats already on the
 * loaded `Job`. Items with a zero/missing count are omitted (no zero chips);
 * when every count is zero the result is `allClear`.
 */
export function deriveJobAttention(
  job: Pick<
    Job,
    "statsEvidenceV2Pending" | "statsSnagsV2Active" | "statsItpsNeedsReview"
  >,
): JobAttention {
  const candidates: JobAttentionItem[] = [
    { key: "evidence", label: "Evidence to review", count: positive(job.statsEvidenceV2Pending) },
    { key: "snags", label: "Open snags", count: positive(job.statsSnagsV2Active) },
    { key: "itps", label: "ITPs to sign off", count: positive(job.statsItpsNeedsReview) },
  ];
  const items = candidates.filter((c) => c.count > 0);
  const total = items.reduce((sum, i) => sum + i.count, 0);
  return { items, allClear: items.length === 0, total };
}
