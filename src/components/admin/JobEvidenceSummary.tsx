import type { Route } from "next";
import { ArrowRight, Camera } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { relativeWhen } from "@/domains/jobs/format";
import { summariseJobEvidence } from "@/domains/jobs/job-evidence";
import type { EvidenceItem } from "@/domains/evidence/types";

/**
 * Admin Job hub — Evidence capture summary.
 *
 * A calm, job-scoped read of the photo / note captures that have come in from
 * the field on this job. Evidence is persisted per-job (jobs/{jobId}/data.json)
 * and GET /api/evidence?jobId=<id> already returns only this job's items, so
 * every count here is real — never a fabricated row or a fake upload.
 *
 * This is a SUMMARY, not the review queue: a status breakdown, provenance
 * (field/Phil vs office), a photo/note split, and a latest-capture caption that
 * deep-links to the full /v2/jobs/[id]/evidence surface (where the thumbnails,
 * drawer, review and reject actions live). It is intentionally NOT a global
 * Evidence module and NOT a photo wall on the landing page — evidence belongs
 * inside the job interface.
 *
 * Honest empty state: "No evidence captured for this job yet." If the field
 * captures nothing, nothing is invented.
 *
 * Cross-ref:
 *   src/domains/jobs/job-evidence.ts — the pure derivation (unit-tested)
 *   src/app/v2/jobs/[jobId]/evidence/page.tsx — the full review queue
 *   src/components/admin/JobOverviewSummary.tsx — the sibling "needs attention"
 *     card (shows the pending-review COUNT; this card shows the capture ledger)
 */

export function JobEvidenceSummary({
  evidence,
  jobId,
  fetchError,
}: {
  evidence: ReadonlyArray<EvidenceItem>;
  jobId: string;
  fetchError: string | null;
}) {
  const summary = summariseJobEvidence(evidence, jobId);
  const evidenceHref = `/v2/jobs/${encodeURIComponent(jobId)}/evidence` as Route;
  const latestWhen = summary.latest ? relativeWhen(summary.latest.capturedAt) : null;

  // Provenance — "did this come from the field?" — read off the real `source`
  // stamp (never guessed). Only shown when there is evidence to attribute.
  const provenance =
    summary.fromField === summary.total
      ? "All captured in the field app"
      : summary.fromOffice === summary.total
        ? "All added in the office"
        : `${summary.fromField} from the field · ${summary.fromOffice} from the office`;
  const kindParts: string[] = [];
  if (summary.photos > 0) {
    kindParts.push(`${summary.photos} photo${summary.photos === 1 ? "" : "s"}`);
  }
  if (summary.notes > 0) {
    kindParts.push(`${summary.notes} note${summary.notes === 1 ? "" : "s"}`);
  }
  const kindClause = kindParts.join(", ");

  return (
    <Card>
      <div className="flex items-center gap-2">
        <Camera aria-hidden="true" className="h-5 w-5 text-text-muted" />
        <CardTitle>Evidence</CardTitle>
      </div>
      <CardDescription className="mt-1">
        Photo and note captures from the field on this job.
      </CardDescription>

      {fetchError ? (
        <p
          className="mt-3 rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          role="alert"
        >
          Couldn&rsquo;t load evidence for this job ({fetchError}). Open the
          evidence tab to retry.
        </p>
      ) : !summary.hasAny ? (
        <p className="mt-3 rounded-card border border-dashed border-border bg-surface-subtle px-3 py-4 text-sm text-text-muted">
          No evidence captured for this job yet. Photos and notes captured on
          site will appear here for review.
        </p>
      ) : (
        <>
          <ul className="mt-3 flex flex-wrap gap-2">
            {summary.pendingReview > 0 ? (
              <li>
                <Pill tone="info">{summary.pendingReview} to review</Pill>
              </li>
            ) : null}
            {summary.reviewed > 0 ? (
              <li>
                <Pill tone="success">{summary.reviewed} reviewed</Pill>
              </li>
            ) : null}
            {summary.rejected > 0 ? (
              <li>
                <Pill tone="danger">{summary.rejected} rejected</Pill>
              </li>
            ) : null}
          </ul>

          <p className="mt-3 text-sm text-text-muted">
            {`${summary.total} capture${summary.total === 1 ? "" : "s"} · ${
              summary.workerCount
            } worker${summary.workerCount === 1 ? "" : "s"}`}
            {summary.latest && latestWhen ? (
              <>
                {` · latest ${latestWhen} by `}
                <span className="text-text">{summary.latest.capturedByName}</span>
              </>
            ) : null}
          </p>

          <p className="mt-1 text-xs text-text-muted">
            {provenance}
            {kindClause ? ` · ${kindClause}` : null}
          </p>

          {summary.missingContext > 0 ? (
            <p className="mt-1 text-xs text-text-muted">
              {summary.missingContext} not linked to a task or area yet.
            </p>
          ) : null}
        </>
      )}

      <div className="mt-4">
        <a
          href={evidenceHref}
          className="inline-flex items-center gap-1 text-sm font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-4 focus:outline-none focus:ring-2 focus:ring-brand-navy"
        >
          Open evidence
          <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
        </a>
      </div>
    </Card>
  );
}
