"use client";

import Link from "next/link";
import type { Route } from "next";
import { AlertOctagon, ChevronRight, ClipboardCheck, MapPin } from "lucide-react";
import { StatusChip, type StatusTone } from "@/components/ui/StatusChip";
import { EmptyState } from "@/components/ui/EmptyState";
import { lastActivityCaption, statusLabel, statusTone } from "@/domains/jobs/format";
import type { Job } from "@/domains/jobs/types";
import {
  jobOpenWork,
  jobOpenWorkSummary,
  type JobOpenWorkKey,
} from "./philJobsListSignals";

// Bridge the jobs-domain tone vocabulary onto the shared StatusChip
// palette. JobStatusTone is neutral/success/warning today; the explicit
// record keeps both sides aligned if either palette widens.
const JOBS_CHIP_TONE: Record<ReturnType<typeof statusTone>, StatusTone> = {
  neutral: "neutral",
  success: "success",
  warning: "warning",
};

// Icons for the per-row "open work on this site" chips — same vocabulary as
// the per-job area cards (PhilJobAreaCard) so the list and the job agree.
const OPEN_WORK_ICON: Record<JobOpenWorkKey, typeof AlertOctagon> = {
  snags: AlertOctagon,
  itps: ClipboardCheck,
};

interface Props {
  initialJobs: ReadonlyArray<Job>;
}

/**
 * Phil jobs list — vertical full-width rows, status pill left, job name
 * large, address smaller, "Updated / Created X ago" right-aligned, and a
 * row of real "open work on this site" chips (open snags · active ITPs)
 * so a worker can see at a glance which site has outstanding work before
 * tapping in. The chips come from the opt-in `?withStats=1` stats and are
 * job-wide site signals — the scoped, personal attention lives on the job
 * screen. When stats are absent the chips simply don't render (no fake
 * "all clear"); see philJobsListSignals.ts.
 *
 * Tap target is the whole row (per doc 27 §8.4). No filters (workers have
 * 1-5 jobs; filtering is meaningless at that scale). Empty state speaks
 * to the worker, not the system ("Ask your PM" — not "0 results").
 *
 * Server-side filtering at api/jobs.js:188-195 means the rows we render
 * are already scoped to the worker's assignedJobIds. The list is purely
 * presentational; no client-side permission logic.
 *
 * Cross-ref:
 *   docs/rebuild-audit/27-interface-usability-pass.md §4 + §8.4
 *   docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md §6 Phil
 */
export function PhilJobsList({ initialJobs }: Props) {
  if (initialJobs.length === 0) {
    return (
      <EmptyState
        title="No jobs assigned yet"
        description="When admin or your leading hand puts you on a job, it'll show up here. Ask your PM if you think one is missing."
      />
    );
  }

  return (
    <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised">
      {initialJobs.map((job) => (
        <li key={job.id}>
          <JobRow job={job} />
        </li>
      ))}
    </ul>
  );
}

function JobRow({ job }: { job: Job }) {
  const caption = lastActivityCaption(job);
  const address = (job.siteAddress ?? "").trim();
  // Real, opt-in (?withStats=1) site signals: open snags + active ITPs. Empty
  // when stats are absent, so the row degrades to exactly its prior look.
  const signals = jobOpenWork(job);
  const summary = jobOpenWorkSummary(signals);
  return (
    <Link
      href={`/phil/jobs/${encodeURIComponent(job.id)}` as Route}
      className="flex min-h-[88px] items-stretch gap-3 px-4 py-3 hover:bg-surface-subtle focus:bg-surface-subtle focus:outline-none"
      aria-label={summary ? `Open ${job.name} — ${summary}` : `Open ${job.name}`}
    >
      <div className="flex shrink-0 items-start pt-1">
        <StatusChip tone={JOBS_CHIP_TONE[statusTone(job.status)]}>
          {statusLabel(job.status)}
        </StatusChip>
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <p className="truncate font-display text-base font-semibold text-text">
          {job.name}
        </p>
        {address ? (
          <p className="mt-0.5 flex items-center gap-1 truncate text-sm text-text-muted">
            <MapPin aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{address}</span>
          </p>
        ) : null}
        {job.ref ? (
          <p className="mt-0.5 truncate text-xs text-text-muted">Ref {job.ref}</p>
        ) : null}

        {signals.length > 0 ? (
          <ul
            className="mt-1.5 flex flex-wrap items-center gap-1.5"
            aria-hidden="true"
          >
            {signals.map((s) => {
              const Icon = OPEN_WORK_ICON[s.key];
              return (
                <li
                  key={s.key}
                  className="inline-flex items-center gap-1 rounded-pill border border-border bg-surface px-2 py-0.5 text-[11px] font-medium text-text-muted"
                >
                  <Icon aria-hidden="true" className="h-3 w-3 shrink-0" />
                  {s.label}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col items-end justify-between pt-1">
        {caption ? (
          <span className="whitespace-nowrap text-[11px] uppercase tracking-wider text-text-muted">
            {caption}
          </span>
        ) : (
          <span aria-hidden="true" />
        )}
        <ChevronRight
          aria-hidden="true"
          className="h-5 w-5 self-center text-text-muted/60"
        />
      </div>
    </Link>
  );
}
