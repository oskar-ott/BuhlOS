"use client";

import Link from "next/link";
import type { Route } from "next";
import { useMemo, useState } from "react";
import {
  AlertOctagon,
  Camera,
  ChevronRight,
  MapPin,
  Search,
} from "lucide-react";
import { Pill } from "@/components/ui/Pill";
import { EmptyState } from "@/components/ui/EmptyState";
import { lastActivityCaption, statusLabel, statusTone } from "@/domains/jobs/format";
import type { Job } from "@/domains/jobs/types";
import { cn } from "@/lib/cn";

interface Props {
  jobs: ReadonlyArray<Job>;
}

/**
 * Admin jobs index list — Phase D6.
 *
 * Mirrors the Phil JobsList row shape (status pill, name, address, when
 * caption, chevron) but adds two pending-count chips per row that
 * deep-link into /v2/jobs/[jobId]/evidence + /v2/jobs/[jobId]/snags.
 *
 * Counts come from /api/jobs?withStats=1 (the V2 namespace counts added
 * in this same slice). When counts are absent (e.g. enrichment failed
 * server-side) the chips simply don't render — the row remains clickable
 * and the admin lands on the per-job page either way.
 *
 * Filtering is a single search box — Phase D6 ships ~5–20 active jobs
 * per admin, which is small enough that a name/address contains-match
 * beats a multi-facet filter bar. A status / pending-only filter can
 * come later if the admin asks for it.
 *
 * Cross-ref:
 *   src/components/phil/PhilJobsList.tsx — row pattern precedent
 *   src/app/v2/jobs/page.tsx — server component that hydrates this list
 */
export function JobsList({ jobs }: Props) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter((j) => {
      const name = j.name.toLowerCase();
      const address = (j.siteAddress ?? "").toLowerCase();
      const ref = (j.ref ?? "").toLowerCase();
      return name.includes(q) || address.includes(q) || ref.includes(q);
    });
  }, [jobs, query]);

  if (jobs.length === 0) {
    return (
      <EmptyState
        title="No active jobs"
        description="When admin or PMs activate a job in the Job Builder, it'll appear here. Archived jobs still live in legacy /admin/jobs."
      />
    );
  }

  return (
    <div className="space-y-3">
      <label className="flex w-full max-w-md items-center gap-2 rounded-card border border-border bg-surface px-3 py-2 text-sm">
        <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by name, address, or ref"
          aria-label="Filter jobs"
          className="w-full bg-transparent text-text outline-none placeholder:text-text-muted"
        />
      </label>

      {filtered.length === 0 ? (
        <Card>
          <CardEmpty query={query} />
        </Card>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised">
          {filtered.map((job) => (
            <li key={job.id}>
              <JobRow job={job} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function JobRow({ job }: { job: Job }) {
  const caption = lastActivityCaption(job);
  const address = (job.siteAddress ?? "").trim();
  const evidencePending = job.statsEvidenceV2Pending ?? 0;
  // statsSnagsV2Active counts needsWorkerAttention statuses
  // (open|in_progress|resolved|rejected) — rejected snags still need a
  // human to handle them.
  const snagsNeedingAttention = job.statsSnagsV2Active ?? 0;
  const hasPending = evidencePending > 0 || snagsNeedingAttention > 0;

  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-stretch sm:gap-3">
      <Link
        href={`/v2/jobs/${encodeURIComponent(job.id)}/evidence` as Route}
        className="flex min-w-0 flex-1 items-start gap-3 hover:underline focus:outline-none focus:ring-2 focus:ring-brand-navy"
        aria-label={`Open evidence for ${job.name}`}
      >
        <div className="flex shrink-0 items-start pt-1">
          <Pill tone={statusTone(job.status)}>{statusLabel(job.status)}</Pill>
        </div>
        <div className="min-w-0 flex-1">
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
      </Link>

      <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
        {caption ? (
          <span className="whitespace-nowrap text-[11px] uppercase tracking-wider text-text-muted">
            {caption}
          </span>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <ActionChip
            href={`/v2/jobs/${encodeURIComponent(job.id)}/evidence`}
            icon={<Camera aria-hidden="true" className="h-3.5 w-3.5" />}
            label="Evidence"
            count={evidencePending}
            highlightWhenNonZero
            ariaLabel={`Open ${evidencePending} pending evidence for ${job.name}`}
          />
          <ActionChip
            href={`/v2/jobs/${encodeURIComponent(job.id)}/snags`}
            icon={<AlertOctagon aria-hidden="true" className="h-3.5 w-3.5" />}
            label="Snags"
            count={snagsNeedingAttention}
            highlightWhenNonZero
            ariaLabel={`Open ${snagsNeedingAttention} snags needing attention for ${job.name}`}
          />
          <Link
            href={`/v2/jobs/${encodeURIComponent(job.id)}/evidence` as Route}
            aria-label={`Open ${job.name}`}
            className="hidden self-center text-text-muted/60 hover:text-text sm:inline-flex"
          >
            <ChevronRight aria-hidden="true" className="h-5 w-5" />
          </Link>
        </div>
        {!hasPending ? (
          <span className="text-[11px] uppercase tracking-wider text-text-muted">
            All clear
          </span>
        ) : null}
      </div>
    </div>
  );
}

interface ActionChipProps {
  href: string;
  icon: React.ReactNode;
  label: string;
  count: number;
  highlightWhenNonZero?: boolean;
  ariaLabel: string;
}

function ActionChip({
  href,
  icon,
  label,
  count,
  highlightWhenNonZero,
  ariaLabel,
}: ActionChipProps) {
  const hot = highlightWhenNonZero && count > 0;
  return (
    <Link
      href={href as Route}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-brand-navy",
        hot
          ? "border-brand-navy bg-brand-navy text-text-inverse hover:bg-accent-ink"
          : "border-border bg-surface text-text hover:bg-surface-subtle"
      )}
    >
      {icon}
      <span>{label}</span>
      <span
        className={cn(
          "ml-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-pill px-1 text-[10px] font-semibold",
          hot ? "bg-accent-yellow text-brand-navy" : "bg-surface-subtle text-text-muted"
        )}
      >
        {count}
      </span>
    </Link>
  );
}

function CardEmpty({ query }: { query: string }) {
  return (
    <div className="py-6 text-center text-sm text-text-muted">
      No jobs match{query ? ` “${query}”` : ""}. Try a different search term.
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-border bg-surface-raised">{children}</div>
  );
}
