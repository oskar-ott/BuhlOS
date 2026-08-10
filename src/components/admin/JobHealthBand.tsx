import Link from "next/link";
import type { Route } from "next";
import { ArrowRight, MapPin } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { JobCrewNames } from "@/components/admin/JobCrewNames";
import { JobStatusControl } from "@/components/admin/JobStatusControl";
import { deriveJobHealth, type JobHealthLevel } from "@/domains/jobs/job-health";
import { healthLabel } from "@/domains/jobs/job-health-list";
import { relativeWhen } from "@/domains/jobs/format";
import { pctWidthClass } from "@/components/admin/pct-width";
import { cn } from "@/lib/cn";
import type { Job } from "@/domains/jobs/types";

/**
 * Job hub HERO (Job Detail Variants 2b/2d) — identity, the verdict, and the
 * quick facts in one card, closed by the brand's yellow rule.
 *
 * "One verdict, first" (2f §01): the health level is the biggest thing after
 * the job name, and every contributing reason is a chip that links straight
 * to where it's fixed (evidence → this job's review queue; tags → /gear).
 * Same derivation the jobs list cards carry (deriveJobHealth over the same
 * withStats read), so clicking an At-risk card lands on a hero that says the
 * same thing in the same voice.
 *
 * All facts are real stats off the loaded Job; an absent stat renders a muted
 * "—" or a designed sentence (2d), never a fabricated number (P7). The hero
 * carries the page's h1 — the shell renders hideHead for this page.
 *
 * Cross-ref:
 *   src/domains/jobs/job-health.ts — the derivation (unit-tested)
 *   src/components/admin/JobsList.tsx — the list-side rendering of the same read
 */

const VERDICT_CHIP: Record<JobHealthLevel, { chip: string; dot: string }> = {
  "at-risk": {
    chip: "border-state-danger-subtle-border bg-state-danger-subtle-bg text-state-danger-subtle-text",
    dot: "bg-state-danger-dot",
  },
  watch: {
    chip: "border-state-warning-subtle-border bg-state-warning-subtle-bg text-state-warning-subtle-text",
    dot: "bg-state-warning-dot",
  },
  good: {
    chip: "border-state-success-subtle-border bg-state-success-subtle-bg text-state-success-subtle-text",
    dot: "bg-state-success-dot",
  },
  unknown: {
    chip: "border-state-neutral-subtle-border bg-state-neutral-subtle-bg text-state-neutral-subtle-text",
    dot: "bg-state-neutral-dot",
  },
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
  const verdict = VERDICT_CHIP[health.level];

  const tasksLabel =
    typeof job.statsTasksTotal === "number" && typeof job.statsTasksComplete === "number"
      ? `Tasks · ${job.statsTasksComplete}/${job.statsTasksTotal}`
      : "Tasks";

  // Third quick fact: last activity when we have it; a draft that has never
  // been touched shows its creation instead. Absent both → omitted, not faked.
  const updatedRel = (job.updatedAt ? relativeWhen(job.updatedAt) : "") || null;
  const createdRel = (!updatedRel && job.createdAt ? relativeWhen(job.createdAt) : "") || null;

  return (
    <Card className="overflow-hidden p-0">
      <div className="p-4 sm:p-7 sm:pb-6">
        <div className="flex items-start justify-between gap-4">
          {idParts.length > 0 ? (
            <p className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted">
              {idParts.join(" · ")}
            </p>
          ) : (
            <span />
          )}
          <div className="shrink-0">
            <JobStatusControl job={job} canEdit={canEdit} />
          </div>
        </div>

        <h1 className="mt-2 font-display text-[26px] font-bold leading-[1.08] tracking-tight text-text sm:text-[36px] sm:leading-[1.05]">
          {job.name}
        </h1>
        {address ? (
          <p className="mt-2 flex items-center gap-1.5 text-sm text-text-muted">
            <MapPin aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{address}</span>
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-5">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={cn(
                "inline-flex items-center gap-2 rounded-[6px] border px-4 py-2 font-display text-[19px] font-bold leading-none",
                verdict.chip
              )}
            >
              <span aria-hidden="true" className={cn("h-2.5 w-2.5 rounded-pill", verdict.dot)} />
              {healthLabel(health.level)}
            </span>
            {health.reasons.map((reason) => {
              const href =
                reason.key === "tags"
                  ? ("/gear" as Route)
                  : (`/v2/jobs/${encodeURIComponent(job.id)}/${reason.key}` as Route);
              return (
                <Link
                  key={reason.key}
                  href={href}
                  className="inline-flex items-center gap-1.5 rounded-[6px] border border-border px-3 py-2 text-xs font-semibold text-text transition-colors hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy"
                >
                  {reason.count} {reason.label.toLowerCase()}
                  <ArrowRight aria-hidden="true" className="h-3 w-3 text-text-muted" />
                </Link>
              );
            })}
            {health.level === "unknown" ? (
              <p className="text-sm text-text-muted">
                Nothing logged yet — health starts when hours or photos come in.
              </p>
            ) : null}
          </div>

          <dl className="flex items-start gap-6 sm:gap-8">
            <div>
              <dt className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted">
                Crew
              </dt>
              <dd
                className={cn(
                  "mt-1 font-display text-[20px] font-bold leading-none",
                  crewKnown ? "text-text" : "text-text-muted"
                )}
              >
                {crewKnown ? job.statsCrewCount : "—"}
              </dd>
            </div>
            <div>
              <dt className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted">
                {tasksLabel}
              </dt>
              <dd className="mt-1 flex items-baseline gap-2">
                <span
                  className={cn(
                    "font-display text-[20px] font-bold tabular-nums leading-none",
                    progressPct != null ? "text-text" : "text-text-muted"
                  )}
                >
                  {progressPct != null ? `${progressPct}%` : "—"}
                </span>
                {progressPct != null ? (
                  <span className="inline-block h-[5px] w-20 overflow-hidden rounded-pill bg-surface-subtle">
                    <span
                      className={cn(
                        "block h-full rounded-pill bg-brand-navy",
                        pctWidthClass(progressPct, 100)
                      )}
                    />
                  </span>
                ) : null}
              </dd>
            </div>
            {updatedRel || createdRel ? (
              <div>
                <dt className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted">
                  {updatedRel ? "Updated" : "Created"}
                </dt>
                <dd className="mt-1 font-display text-[20px] font-bold leading-none text-text">
                  {updatedRel ?? createdRel}
                </dd>
              </div>
            ) : null}
          </dl>
        </div>

        {/* Assigned crew by NAME — client-fetched off the admin register, so it
            appears after paint and renders nothing for non-admin viewers or on
            error (the count above stays the honest fallback). */}
        <JobCrewNames jobId={job.id} />
      </div>
      <div aria-hidden="true" className="h-1 w-full bg-accent-yellow" />
    </Card>
  );
}
