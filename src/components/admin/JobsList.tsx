"use client";

import Link from "next/link";
import type { Route } from "next";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  AlertOctagon,
  Camera,
  ChevronRight,
  ClipboardCheck,
  MapPin,
  PencilRuler,
  Search,
  X,
} from "lucide-react";
import { Pill } from "@/components/ui/Pill";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  JOB_STATUS_OPTIONS,
  lastActivityCaption,
  statusLabel,
  statusTone,
} from "@/domains/jobs/format";
import {
  filterJobs,
  jobStatusCounts,
  jobsEmptyStateMessage,
  parseJobStatusParam,
} from "@/domains/jobs/list-filter";
import { isQaTestJobName } from "@/domains/jobs/test-data";
import type { Job, JobStatus } from "@/domains/jobs/types";
import {
  clearRememberedFilters,
  writeRememberedFilters,
  type RememberedFilterSpec,
} from "@/lib/storage/remembered-filters";
import { useApplyRememberedFiltersOnce } from "@/lib/storage/use-remembered-filters";
import { cn } from "@/lib/cn";

interface Props {
  jobs: ReadonlyArray<Job>;
  /** Admin-only: show the per-row "Build" action that opens the Job Builder. */
  canBuild?: boolean;
}

/** Per-device remembered default for this list (issue #216). Exported for
 *  the render test so it exercises the real key + validators. */
export const JOBS_FILTERS_STORAGE_KEY = "buhlos.jobs-list.filters";
export const JOBS_FILTER_SPEC: RememberedFilterSpec = {
  status: (v) => parseJobStatusParam(v) !== null,
  q: (v) => v.trim() !== "" && v.length <= 200,
};

/** How long a search keystroke waits before being mirrored into the URL. */
const SEARCH_URL_DEBOUNCE_MS = 250;

/**
 * Admin jobs index list — Phase D6, filters URL-driven since #216.
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
 * Filtering (#216): status pills + the search box, both reflected in the
 * URL (`?status=` + `?q=`) so views are shareable, both restorable from a
 * remembered per-device default. Mechanics:
 *
 *   - Filter state is read LIVE from useSearchParams() — never snapshotted
 *     into useState — so same-route deep links re-filter the list (the
 *     soft-nav pitfall, #116→#118).
 *   - Filtering itself stays client-side over the already-loaded array.
 *     Interaction writes mirror the URL via window.history.replaceState
 *     (the Next-sanctioned shallow update): useSearchParams stays in sync
 *     WITHOUT re-running the server component, so a pill click or
 *     keystroke never refetches /api/jobs. router.replace is reserved for
 *     the once-per-mount remembered-default application, where a server
 *     round-trip is acceptable.
 *   - The search <input> keeps local echo state for typing latency, synced
 *     FROM the URL when the param changes externally (lastWrittenQueryRef
 *     distinguishes our own debounced writes from external navigations).
 *   - Memory: write-through on user interaction only; applied on mount
 *     only when the URL carries neither filter param (URL always wins);
 *     "Reset to all" clears the URL params and the stored default.
 *
 * Cross-ref:
 *   src/components/phil/PhilJobsList.tsx — row pattern precedent
 *   src/app/v2/jobs/page.tsx — server component that hydrates this list
 *   src/domains/jobs/list-filter.ts — the pure filter matrix
 */
export function JobsList({ jobs, canBuild = false }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // URL is the source of truth for the status filter (validated; unknown
  // values degrade to "all").
  const status = parseJobStatusParam(searchParams.get("status"));
  const urlQuery = searchParams.get("q") ?? "";

  // Local echo for the search box; the URL mirror is debounced. The ref
  // tracks the last value THIS component intends/wrote so the sync effect
  // below only adopts genuinely external URL changes (deep links) instead
  // of clobbering in-flight typing with our own write echo.
  const [query, setQuery] = useState(urlQuery);
  const lastWrittenQueryRef = useRef(urlQuery);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (urlQuery !== lastWrittenQueryRef.current) {
      lastWrittenQueryRef.current = urlQuery;
      setQuery(urlQuery);
    }
  }, [urlQuery]);

  // Clear any pending URL write on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Apply the remembered per-device default (only when the URL is clean of
  // both filter params; storage is read inside the effect, never in render).
  useApplyRememberedFiltersOnce(JOBS_FILTERS_STORAGE_KEY, JOBS_FILTER_SPEC);

  /**
   * Mirror the given filter set into the URL + the per-device memory.
   * Reads window.location.search at call time (interaction handlers only)
   * so a debounced search write can't resurrect a status the user changed
   * while the timer was pending.
   */
  const writeFilters = (next: { status: JobStatus | null; query: string }) => {
    const params = new URLSearchParams(window.location.search);
    if (next.status) params.set("status", next.status);
    else params.delete("status");
    const q = next.query.trim();
    if (q) params.set("q", q);
    else params.delete("q");
    const qs = params.toString();
    try {
      window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
    } catch {
      // History API throttled — filtering still works from local state.
    }
    writeRememberedFilters(JOBS_FILTERS_STORAGE_KEY, { status: next.status, q });
  };

  const handleStatusClick = (next: JobStatus | null) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    writeFilters({ status: next, query });
  };

  const handleQueryChange = (value: string) => {
    setQuery(value);
    lastWrittenQueryRef.current = value.trim();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const freshStatus = parseJobStatusParam(
        new URLSearchParams(window.location.search).get("status")
      );
      writeFilters({ status: freshStatus, query: value });
    }, SEARCH_URL_DEBOUNCE_MS);
  };

  const handleReset = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setQuery("");
    lastWrittenQueryRef.current = "";
    const params = new URLSearchParams(window.location.search);
    params.delete("status");
    params.delete("q");
    const qs = params.toString();
    try {
      window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
    } catch {
      // Best-effort, as above.
    }
    clearRememberedFilters(JOBS_FILTERS_STORAGE_KEY);
  };

  // Filter on the LIVE keystroke value (not the debounced URL mirror) so
  // the list narrows instantly while typing.
  const filtered = useMemo(
    () => filterJobs(jobs, { status, query }),
    [jobs, status, query]
  );

  const counts = useMemo(() => jobStatusCounts(jobs), [jobs]);
  // Statuses with zero jobs stay hidden (this page excludes archived rows
  // server-side — a permanently-dead pill would imply otherwise) UNLESS the
  // URL deep-links to one, in which case the pill renders so the active
  // filter is visible and clearable.
  const statusOptions = JOB_STATUS_OPTIONS.filter(
    (s) => (counts.get(s) ?? 0) > 0 || status === s
  );

  const filtersActive = status !== null || query.trim() !== "";

  if (jobs.length === 0) {
    return (
      <EmptyState
        title="No active jobs"
        description="When admin or PMs activate a job in the Job Builder, it'll appear here. Archived jobs aren't listed."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex w-full max-w-md items-center gap-2 rounded-card border border-border bg-surface px-3 py-2 text-sm">
          <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
          <input
            type="search"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder="Filter by name, address, or ref"
            aria-label="Filter jobs"
            className="w-full bg-transparent text-text outline-none placeholder:text-text-muted"
          />
        </label>

        <div
          role="group"
          aria-label="Filter jobs by status"
          className="flex flex-wrap items-center gap-1.5"
        >
          <FilterPill
            label="All"
            count={jobs.length}
            selected={status === null}
            onClick={() => handleStatusClick(null)}
          />
          {statusOptions.map((s) => (
            <FilterPill
              key={s}
              label={statusLabel(s)}
              count={counts.get(s) ?? 0}
              selected={status === s}
              onClick={() => handleStatusClick(s)}
            />
          ))}
          {filtersActive ? (
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-xs font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2 hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy"
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
              Reset to all
            </button>
          ) : null}
        </div>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <div className="py-6 text-center text-sm text-text-muted">
            {jobsEmptyStateMessage({ status, query })}
          </div>
        </Card>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised">
          {filtered.map((job) => (
            <li key={job.id}>
              <JobRow job={job} canBuild={canBuild} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Status filter pill. Selection uses the navy brand accent (doc 27 §6 —
 * brand accents mark SELECTION, never entity state; the row's status Pill
 * keeps the five-tone palette via statusTone).
 */
function FilterPill({
  label,
  count,
  selected,
  onClick,
}: {
  label: string;
  count: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-brand-navy",
        selected
          ? "border-brand-navy bg-brand-navy text-text-inverse"
          : "border-border bg-surface text-text hover:bg-surface-subtle"
      )}
    >
      <span>{label}</span>
      <span
        className={cn(
          "inline-flex h-4 min-w-[16px] items-center justify-center rounded-pill px-1 text-[10px] font-semibold",
          selected ? "bg-accent-yellow text-brand-navy" : "bg-surface-subtle text-text-muted"
        )}
      >
        {count}
      </span>
    </button>
  );
}

function JobRow({ job, canBuild }: { job: Job; canBuild: boolean }) {
  const caption = lastActivityCaption(job);
  const address = (job.siteAddress ?? "").trim();
  const evidencePending = job.statsEvidenceV2Pending ?? 0;
  // statsSnagsV2Active counts needsWorkerAttention statuses
  // (open|in_progress|resolved|rejected) — rejected snags still need a
  // human to handle them.
  const snagsNeedingAttention = job.statsSnagsV2Active ?? 0;
  // statsItpsActive (E1a) counts non-archived instances in
  // pending|in-progress|witnessed — anything that still needs work or
  // review.
  const itpsActive = job.statsItpsActive ?? 0;
  const hasPending =
    evidencePending > 0 || snagsNeedingAttention > 0 || itpsActive > 0;

  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-stretch sm:gap-3">
      <Link
        href={`/v2/jobs/${encodeURIComponent(job.id)}/evidence` as Route}
        className="flex min-w-0 flex-1 items-start gap-3 hover:underline focus:outline-none focus:ring-2 focus:ring-brand-navy"
        aria-label={`Open evidence for ${job.name}`}
      >
        <div className="flex shrink-0 flex-col items-start gap-1 pt-1">
          <Pill tone={statusTone(job.status)}>{statusLabel(job.status)}</Pill>
          {/* QA smoke runs leave SMOKE_TEST_/QA_SEED_ rows here — label them
              so nobody mistakes the seeded fixture for a real site. */}
          {isQaTestJobName(job.name) ? <Pill tone="neutral">Test data</Pill> : null}
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
          {/* #198 canonical progress — counts first, % only with a total. */}
          {typeof job.statsTasksTotal === "number" &&
          typeof job.statsTasksComplete === "number" ? (
            <p className="mt-0.5 text-xs text-text-muted">
              {job.statsTasksTotal === 0
                ? "No tasks yet"
                : `${job.statsTasksComplete}/${job.statsTasksTotal} tasks · ${Math.round((job.statsTasksComplete / job.statsTasksTotal) * 100)}%`}
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
          <ActionChip
            href={`/v2/jobs/${encodeURIComponent(job.id)}/itps`}
            icon={<ClipboardCheck aria-hidden="true" className="h-3.5 w-3.5" />}
            label="ITPs"
            count={itpsActive}
            highlightWhenNonZero
            ariaLabel={`Open ${itpsActive} ITPs needing attention for ${job.name}`}
          />
          {canBuild ? (
            <ActionChip
              href={`/v2/jobs/${encodeURIComponent(job.id)}/builder`}
              icon={<PencilRuler aria-hidden="true" className="h-3.5 w-3.5" />}
              label="Build"
              ariaLabel={`Open the builder for ${job.name}`}
            />
          ) : null}
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
  /** Omit for action chips that aren't a count (e.g. "Build"). */
  count?: number;
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
  const hot = highlightWhenNonZero && (count ?? 0) > 0;
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
      {count !== undefined ? (
        <span
          className={cn(
            "ml-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-pill px-1 text-[10px] font-semibold",
            hot ? "bg-accent-yellow text-brand-navy" : "bg-surface-subtle text-text-muted"
          )}
        >
          {count}
        </span>
      ) : null}
    </Link>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-border bg-surface-raised">{children}</div>
  );
}
