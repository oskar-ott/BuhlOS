import Link from "next/link";
import type { Route } from "next";
import { HardHat, ListChecks, MapPin } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { JobCrewNames } from "@/components/admin/JobCrewNames";
import { JobStatusControl } from "@/components/admin/JobStatusControl";
import { deriveJobHealth, type JobHealthLevel } from "@/domains/jobs/job-health";
import { healthLabel } from "@/domains/jobs/job-health-list";
import type { Job } from "@/domains/jobs/types";

/**
 * Job hub health band — the one-glance verdict at the top of /v2/jobs/[jobId].
 *
 * Closes the list→detail broken promise from the 2026-08-09 job-hub audit
 * (finding A1): the jobs LIST shows a rolled-up At risk / Watch / On track
 * read (deriveJobHealth), but clicking through landed on a page that never
 * mentioned health at all. This band renders the SAME derivation over the
 * same withStats read, with each contributing reason linking to where it's
 * actioned (evidence → this job's review queue; tags → the /gear board).
 *
 * Also the job's identity line (IV code · ref · type · address) and quick
 * facts (crew, task progress) — all real stats off the loaded Job; an absent
 * stat renders a muted "—", never a fabricated number (P7). Replaces the old
 * JobHeaderCard ref strip and the orphaned JobOverviewSummary.
 *
 * Cross-ref:
 *   src/domains/jobs/job-health.ts — the derivation (unit-tested)
 *   src/components/admin/JobsList.tsx — the list-side rendering of the same read
 */

const HEALTH_TONE: Record<JobHealthLevel, "danger" | "warning" | "success" | "neutral"> = {
  "at-risk": "danger",
  watch: "warning",
  good: "success",
  unknown: "neutral",
};

export function JobHealthBand({
  job,
  canEdit,
  progressPct,
}: {
  job: Job;
  canEdit: boolean;
  /** Canonical pooled task progress (0–100) or null when the job has no tasks. */
  progressPct: number | null;
}) {
  const health = deriveJobHealth(job);
  const idParts = [job.code, job.ref ? `Ref ${job.ref}` : null, job.typeName].filter(Boolean);
  const address = (job.siteAddress ?? "").trim();
  const crewKnown = typeof job.statsCrewCount === "number";

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {idParts.length > 0 ? (
            <p className="font-mono text-xs uppercase tracking-wider text-text-muted">
              {idParts.join(" · ")}
            </p>
          ) : null}
          {address ? (
            <p className="mt-1 flex items-center gap-1 text-sm text-text-muted">
              <MapPin aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 break-words">{address}</span>
            </p>
          ) : null}
        </div>
        <div className="shrink-0">
          <JobStatusControl job={job} canEdit={canEdit} />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill tone={HEALTH_TONE[health.level]}>{healthLabel(health.level)}</Pill>
          {health.reasons.map((reason) => {
            const href =
              reason.key === "tags"
                ? ("/gear" as Route)
                : (`/v2/jobs/${encodeURIComponent(job.id)}/${reason.key}` as Route);
            return (
              <Link
                key={reason.key}
                href={href}
                className="inline-flex items-center gap-1 rounded-pill border border-border bg-surface px-2.5 py-0.5 text-xs font-medium text-text transition-colors hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy"
              >
                {reason.count} {reason.label.toLowerCase()}
              </Link>
            );
          })}
        </div>

        <dl className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-1.5">
            <HardHat aria-hidden="true" className="h-4 w-4 text-text-muted" />
            <dt className="text-text-muted">Crew</dt>
            <dd className={crewKnown ? "font-medium text-text" : "text-text-muted"}>
              {crewKnown ? job.statsCrewCount : "—"}
            </dd>
          </div>
          <div className="flex items-center gap-1.5">
            <ListChecks aria-hidden="true" className="h-4 w-4 text-text-muted" />
            <dt className="text-text-muted">Tasks</dt>
            <dd className={progressPct != null ? "font-medium text-text" : "text-text-muted"}>
              {progressPct != null ? `${progressPct}%` : "—"}
            </dd>
          </div>
        </dl>
      </div>

      {/* Assigned crew by NAME — client-fetched off the admin register, so it
          appears after paint and renders nothing for non-admin viewers or on
          error (the count above stays the honest fallback). */}
      <JobCrewNames jobId={job.id} />
    </Card>
  );
}
