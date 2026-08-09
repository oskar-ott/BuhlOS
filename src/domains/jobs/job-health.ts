import type { Job } from "./types";

/**
 * Pure job HEALTH derivation from real signals (#226).
 *
 * A single rolled-up "how's this job doing" level for the jobs list / hub,
 * derived ONLY from the real, blob-derived `stats*` already on the loaded `Job`
 * (the same source deriveJobAttention uses — this is its judgemental sibling:
 * attention lists the backlog, health classifies it). NO new I/O, NO React, NO
 * fabricated numbers — a missing/zero stat contributes nothing, and when no stat
 * is loaded at all the level is the honest `unknown`, never a fake "good" (P7).
 *
 * The level is a SUMMARY; the `reasons` carry the raw counts (the truth). The
 * one threshold (AT_RISK_SOFT_TOTAL) is named + documented
 * (docs/job-health-thresholds.md), not a magic number buried in a branch.
 *
 * Signal severity:
 *   - HARD: expired gear tags (statsExpiredTags) — out-of-test equipment on site
 *     is a live compliance breach, so ANY drives at-risk. (Cross-job: its
 *     destination is /gear, not a per-job tab — see `reason.key`.)
 *   - SOFT: evidence to review — actionable
 *     backlog, each with a per-job tab. A large soft backlog also tips at-risk.
 *
 * Cross-ref:
 *   src/domains/jobs/attention.ts — the backlog list this classifies
 *   src/components/admin/JobsList.tsx / JobHealthBand.tsx — the consumers
 */

export type JobHealthLevel = "good" | "watch" | "at-risk" | "unknown";

/** Reason key. For soft reasons this doubles as the per-job tab segment
 *  (/v2/jobs/<id>/<key>); `tags` is cross-job (its destination is /gear). */
export type JobHealthReasonKey = "evidence" | "tags";

export interface JobHealthReason {
  key: JobHealthReasonKey;
  label: string;
  count: number;
  severity: "soft" | "hard";
}

export interface JobHealth {
  level: JobHealthLevel;
  /** Contributing signals with a real positive count, HARD first then SOFT. */
  reasons: JobHealthReason[];
  /** Sum of all reason counts (0 when good/unknown). */
  total: number;
}

/**
 * A large soft backlog (evidence to review) tips a job from "watch" to
 * "at-risk" even with no hard breach. Conservative + documented
 * (docs/job-health-thresholds.md); tune in ONE place. A hard signal trips
 * at-risk on its own regardless of this.
 */
export const AT_RISK_SOFT_TOTAL = 10;

type HealthStats = Pick<
  Job,
  "statsEvidenceV2Pending" | "statsSnagsV2Active" | "statsItpsNeedsReview" | "statsExpiredTags"
>;

function isPresent(v: number | null | undefined): boolean {
  return typeof v === "number" && Number.isFinite(v);
}
function positive(v: number | null | undefined): number {
  return isPresent(v) && (v as number) > 0 ? (v as number) : 0;
}

/**
 * Derive a job's health from the real stats on the loaded `Job`. Reasons with a
 * zero/missing count are omitted; when no stat is loaded at all the level is
 * `unknown` (not a fabricated "good").
 */
export function deriveJobHealth(job: HealthStats): JobHealth {
  const anySignalLoaded =
    isPresent(job.statsExpiredTags) ||
    isPresent(job.statsEvidenceV2Pending) ||
    isPresent(job.statsSnagsV2Active) ||
    isPresent(job.statsItpsNeedsReview);

  const candidates: JobHealthReason[] = [
    { key: "tags", label: "Expired gear tags", count: positive(job.statsExpiredTags), severity: "hard" },
    { key: "evidence", label: "Evidence to review", count: positive(job.statsEvidenceV2Pending), severity: "soft" },
  ];
  const reasons = candidates.filter((c) => c.count > 0); // already HARD-first by order

  const hardTotal = reasons.filter((r) => r.severity === "hard").reduce((s, r) => s + r.count, 0);
  const softTotal = reasons.filter((r) => r.severity === "soft").reduce((s, r) => s + r.count, 0);
  const total = hardTotal + softTotal;

  let level: JobHealthLevel;
  if (!anySignalLoaded) level = "unknown";
  else if (hardTotal > 0 || softTotal >= AT_RISK_SOFT_TOTAL) level = "at-risk";
  else if (total > 0) level = "watch";
  else level = "good";

  return { level, reasons, total };
}
