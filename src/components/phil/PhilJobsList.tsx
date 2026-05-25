"use client";

import Link from "next/link";
import type { Route } from "next";
import { ChevronRight, MapPin } from "lucide-react";
import { Pill } from "@/components/ui/Pill";
import { EmptyState } from "@/components/ui/EmptyState";
import { lastActivityCaption, statusLabel, statusTone } from "@/domains/jobs/format";
import type { Job } from "@/domains/jobs/types";

interface Props {
  initialJobs: ReadonlyArray<Job>;
}

/**
 * Phil jobs list — vertical full-width rows, status pill left, job name
 * large, address smaller, "Updated / Created X ago" right-aligned.
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
  return (
    <Link
      href={`/phil/jobs/${encodeURIComponent(job.id)}` as Route}
      className="flex min-h-[88px] items-stretch gap-3 px-4 py-3 hover:bg-surface-subtle focus:bg-surface-subtle focus:outline-none"
      aria-label={`Open ${job.name}`}
    >
      <div className="flex shrink-0 items-start pt-1">
        <Pill tone={statusTone(job.status)}>{statusLabel(job.status)}</Pill>
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
