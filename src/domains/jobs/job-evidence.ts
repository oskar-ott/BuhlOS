import type { EvidenceItem } from "@/domains/evidence/types";

/**
 * Pure per-job evidence derivation for the admin Job hub Overview.
 *
 * Evidence is persisted per-job (jobs/{jobId}/data.json, api/evidence.js) and
 * GET /api/evidence?jobId=<id> already returns only this job's captures,
 * newest first. This helper turns that real list into the calm capture summary
 * the hub Overview shows, deep-linking to the full /v2/jobs/[id]/evidence
 * review queue rather than dumping a photo wall on the landing page.
 *
 * The server only ever persists status `submitted | reviewed | rejected`
 * (the `uploading` / `pending_sync` values in the enum are client-only capture
 * states that never serialise — see src/domains/evidence/schema.ts §status).
 * We bucket the three real states and ignore anything else defensively.
 *
 * "Missing context" = a capture attached to neither a task, an area, nor a
 * stage. It is a real, derivable quality signal (the office may want the field
 * to say where a loose photo belongs), not a fabricated one.
 *
 * Strictly pure (no fetch, no React) and never fabricates: empty input yields
 * a zeroed summary with `hasAny: false`, so the card can show an honest "no
 * evidence yet" rather than invented rows.
 *
 * Cross-ref:
 *   src/domains/jobs/attention.ts — sibling pure derivation (precedent)
 *   src/domains/evidence/types.ts — EvidenceItem shape
 *   src/components/admin/JobEvidenceSummary.tsx — the consumer
 */

export interface JobEvidenceSummary {
  jobId: string;
  total: number;
  /** status === "submitted" — captured, awaiting admin review. */
  pendingReview: number;
  /** status === "reviewed". */
  reviewed: number;
  /** status === "rejected". */
  rejected: number;
  /** Captures with no task, area, or stage attached. */
  missingContext: number;
  /** Distinct workers who captured evidence on this job. */
  workerCount: number;
  /** Newest capture, for the "latest" caption, or null. */
  latest: { capturedByName: string; capturedAt: string } | null;
  hasAny: boolean;
}

export type EvidenceStageKey = "roughIn" | "fitOff" | "none";

export interface JobEvidenceStageGroup {
  stage: EvidenceStageKey;
  count: number;
}

/** A capture with no task / area / stage is "unattached" — missing context. */
function isMissingContext(item: EvidenceItem): boolean {
  return !item.taskId && !item.areaId && !item.stage;
}

/**
 * Derive the per-job evidence summary. `jobId` is applied defensively even
 * though the API already scopes the list — so a caller that ever passes a
 * mixed list still gets a correct, this-job-only summary.
 */
export function summariseJobEvidence(
  evidence: ReadonlyArray<EvidenceItem>,
  jobId: string,
): JobEvidenceSummary {
  const summary: JobEvidenceSummary = {
    jobId,
    total: 0,
    pendingReview: 0,
    reviewed: 0,
    rejected: 0,
    missingContext: 0,
    workerCount: 0,
    latest: null,
    hasAny: false,
  };
  if (!Array.isArray(evidence) || evidence.length === 0) return summary;

  const workers = new Set<string>();

  for (const item of evidence) {
    if (!item || item.jobId !== jobId) continue;

    summary.total += 1;
    summary.hasAny = true;
    if (item.capturedById) workers.add(item.capturedById);
    if (isMissingContext(item)) summary.missingContext += 1;

    switch (item.status) {
      case "submitted":
        summary.pendingReview += 1;
        break;
      case "reviewed":
        summary.reviewed += 1;
        break;
      case "rejected":
        summary.rejected += 1;
        break;
      // uploading / pending_sync are client-only and never persisted.
    }

    if (
      item.capturedAt &&
      (!summary.latest || item.capturedAt > summary.latest.capturedAt)
    ) {
      summary.latest = {
        capturedByName: item.capturedByName || "Unknown",
        capturedAt: item.capturedAt,
      };
    }
  }

  summary.workerCount = workers.size;
  return summary;
}

/**
 * Count this job's captures by stage (rough-in / fit-off / unstaged). Useful
 * for a subtle "where the evidence sits" breakdown without a photo wall.
 */
export function groupEvidenceByStage(
  evidence: ReadonlyArray<EvidenceItem>,
  jobId: string,
): JobEvidenceStageGroup[] {
  const counts: Record<EvidenceStageKey, number> = { roughIn: 0, fitOff: 0, none: 0 };
  if (Array.isArray(evidence)) {
    for (const item of evidence) {
      if (!item || item.jobId !== jobId) continue;
      const key: EvidenceStageKey =
        item.stage === "roughIn" ? "roughIn" : item.stage === "fitOff" ? "fitOff" : "none";
      counts[key] += 1;
    }
  }
  return (["roughIn", "fitOff", "none"] as const)
    .map((stage) => ({ stage, count: counts[stage] }))
    .filter((g) => g.count > 0);
}

export interface JobEvidenceAttention {
  /** True when captures are awaiting admin review on this job. */
  needsReview: boolean;
  count: number;
}

/**
 * The actionable signal for the office: are there captures awaiting review?
 * Mirrors deriveJobAttention's positive-only discipline.
 */
export function deriveEvidenceAttention(summary: JobEvidenceSummary): JobEvidenceAttention {
  return {
    needsReview: summary.pendingReview > 0,
    count: summary.pendingReview,
  };
}
