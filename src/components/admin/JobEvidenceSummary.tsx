import type { Route } from "next";
import { ArrowRight, Images } from "lucide-react";
import { Card, CardKicker } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { relativeWhen } from "@/domains/jobs/format";
import { latestJobPhotos, summariseJobEvidence } from "@/domains/jobs/job-evidence";
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
 *   src/components/admin/JobHealthBand.tsx — the hub's rolled-up health read
 *     (shows the pending-review COUNT as a reason chip; this card is the ledger)
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
  const thumbs = latestJobPhotos(evidence, jobId, 6);
  const evidenceHref = `/v2/jobs/${encodeURIComponent(jobId)}/evidence` as Route;
  const photosHref = `/v2/jobs/${encodeURIComponent(jobId)}/photos` as Route;
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

  // Overflow tile (2a "+15"): when the wall holds more photos than the strip
  // shows, the last cell becomes the honest remainder count.
  const visibleThumbs = summary.photos > thumbs.length ? thumbs.slice(0, -1) : thumbs;
  const overflowCount = summary.photos - visibleThumbs.length;

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardKicker>Evidence</CardKicker>
        <div className="flex shrink-0 items-center gap-2">
          {/* The two-row "Sections" nav card folded in here (2026-08-09 job-hub
              audit, finding C14): Evidence review + the read-only photo wall
              are this card's two destinations — no separate nav card. The
              Review button goes navy-hot only while something actually waits. */}
          <a
            href={photosHref}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-[4px] border border-border bg-surface px-3 py-1.5 text-sm font-semibold text-text transition-colors hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy"
          >
            <Images aria-hidden="true" className="h-4 w-4 text-text-muted" />
            Photos
          </a>
          <a
            href={evidenceHref}
            className={
              summary.pendingReview > 0
                ? "inline-flex shrink-0 items-center gap-1.5 rounded-[4px] bg-brand-navy px-3 py-1.5 text-sm font-semibold text-text-inverse transition-colors hover:bg-accent-ink focus:outline-none focus:ring-2 focus:ring-brand-navy"
                : "inline-flex shrink-0 items-center gap-1.5 rounded-[4px] border border-border bg-surface px-3 py-1.5 text-sm font-semibold text-text transition-colors hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy"
            }
          >
            {summary.pendingReview > 0 ? `Review ${summary.pendingReview}` : "Review"}
            <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>

      {fetchError ? (
        <p
          className="mt-3 rounded-card border border-state-warning-subtle-border bg-state-warning-subtle-bg px-3 py-2 text-sm text-state-warning-subtle-text"
          role="alert"
        >
          Couldn&rsquo;t load evidence for this job ({fetchError}). Open the evidence tab to retry.
        </p>
      ) : !summary.hasAny ? (
        // 2d — absence is designed: what will land here, and from where.
        <div className="mt-4 rounded-[4px] border border-border bg-surface-subtle px-5 py-6">
          <p className="text-sm font-semibold text-text">No site photos yet</p>
          <p className="mt-1 text-sm text-text-muted">
            The first captures land here the moment the crew uploads from site — you&rsquo;ll
            review them in one place.
          </p>
        </div>
      ) : (
        <>
          {/* Latest-photos strip (2026-08-09 audit follow-up): the card used to
              describe photos without showing any. Real thumbnails only —
              latestJobPhotos skips notes and URL-less rows — each opening the
              full Photos wall. */}
          {visibleThumbs.length > 0 ? (
            <a
              href={photosHref}
              className="mt-4 grid grid-cols-4 gap-1.5 rounded-[4px] focus:outline-none focus:ring-2 focus:ring-brand-navy sm:grid-cols-6"
              aria-label={`Open the photo wall — ${summary.photos} photo${summary.photos === 1 ? "" : "s"} on this job`}
            >
              {visibleThumbs.map((t) => (
                // eslint-disable-next-line @next/next/no-img-element -- Blob-hosted capture, same raw-img pattern as PhotosGallery
                <img
                  key={t.id}
                  src={t.url}
                  alt={`Capture by ${t.capturedByName}`}
                  loading="lazy"
                  className="aspect-square w-full rounded-[4px] border border-border object-cover"
                />
              ))}
              {overflowCount > 0 ? (
                <span className="flex aspect-square items-center justify-center rounded-[4px] border border-border bg-surface-subtle font-mono text-xs font-semibold text-text-muted">
                  +{overflowCount}
                </span>
              ) : null}
            </a>
          ) : null}

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
    </Card>
  );
}
