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
 * Provenance is a real persisted signal too. api/evidence.js stamps every
 * capture with `source`: an admin-role capture writes `admin`, anyone else
 * (the tradies / leading hands who use Phil in the field) writes `phil` (see
 * sourceForUser). So `fromField` / `fromOffice` answer "did this come from the
 * field?" honestly — they are read straight off the row, never guessed. A
 * source that is neither (the reserved `system`, or an unknown future value)
 * counts toward `total` but is attributed to neither bucket. `kind` is the
 * other real discriminator — `photo` vs `note` — surfaced as a plain split.
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
  /** source === "phil" — captured in the field via the Phil app. */
  fromField: number;
  /** source === "admin" — added from the office. */
  fromOffice: number;
  /** kind === "photo". */
  photos: number;
  /** kind === "note". */
  notes: number;
  /** Newest capture, for the "latest" caption, or null. */
  latest: { capturedByName: string; capturedAt: string } | null;
  hasAny: boolean;
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
    fromField: 0,
    fromOffice: 0,
    photos: 0,
    notes: 0,
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

    // Provenance, read straight off the row (api/evidence.js sourceForUser).
    // A "system"/unknown source is intentionally attributed to neither bucket.
    if (item.source === "phil") summary.fromField += 1;
    else if (item.source === "admin") summary.fromOffice += 1;

    if (item.kind === "photo") summary.photos += 1;
    else if (item.kind === "note") summary.notes += 1;

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
