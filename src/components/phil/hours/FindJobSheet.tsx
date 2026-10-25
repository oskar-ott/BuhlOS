"use client";

import { useState, type ReactNode } from "react";
import { MapPin, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  dayDate,
  isFinishedJob,
  lastLoggedDateForJob,
  searchJobs,
  weekdayName,
  type HoursJob,
} from "@/domains/timesheets/hours-view";
import type { TimeEntry } from "@/domains/timesheets/types";
import { useJobHistorySearch } from "../useJobHistorySearch";
import { HoursSheet } from "./HoursSheet";

/**
 * Find another job (docs/phil-hours.md): the worker's jobs as a list (the
 * current one navy, "Your last job"), a search over name or address, and
 * finished jobs — found only through search, tagged `finished` — for callback
 * work. Leave days are not jobs: they never appear here or in the results;
 * the footer points at the Sick day / Holiday buttons instead.
 */
export function FindJobSheet({
  open,
  onClose,
  date,
  jobs,
  currentJobId,
  entries,
  onPick,
  nested = false,
}: {
  open: boolean;
  onClose: () => void;
  date: string;
  jobs: ReadonlyArray<HoursJob>;
  currentJobId: string | null;
  entries: ReadonlyArray<Pick<TimeEntry, "date" | "allocations">>;
  onPick: (job: HoursJob) => void;
  /** Opened from inside the Fix sheet — stacks above it. */
  nested?: boolean;
}): ReactNode {
  const [query, setQuery] = useState("");
  const q = query.trim();
  const mine = searchJobs(jobs, q);
  const history = useJobHistorySearch(query, open && q.length >= 2);
  const known = new Set(jobs.map((j) => j.id));
  const found: HoursJob[] =
    history.kind === "ready"
      ? history.jobs
          .filter((j) => !known.has(j.id))
          .map((j) => ({
            id: j.id,
            name: j.name,
            ref: j.code ?? j.ref ?? null,
            address: j.siteAddress ?? null,
            completedAt: j.completedAt ?? null,
            status: j.status ?? null,
          }))
      : [];
  const matchCount = mine.length + found.length;

  return (
    <HoursSheet
      open={open}
      onClose={onClose}
      title="Find another job"
      subtitle={`For ${weekdayName(date)} · ${dayDate(date)}`}
      testId="hours-sheet-find-job"
      nested={nested}
      footer={{
        note: (
          <p>
            Sick days and holidays aren&rsquo;t jobs. Close this and use the Sick day or Holiday
            buttons.
          </p>
        ),
      }}
    >
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
            Search all jobs, finished ones too
          </span>
          <span className="relative block">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-text-muted"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Job name or address"
              autoComplete="off"
              data-testid="hours-job-search"
              className="h-12 w-full rounded-card border border-border-strong bg-surface pl-10 pr-3 text-[15px] text-text focus:border-brand-navy focus:outline-none"
            />
          </span>
        </label>

        {q ? (
          <p className="text-[13px] text-text-muted" role="status">
            {history.kind === "searching"
              ? `Checking finished jobs for “${q}”…`
              : `${matchCount} ${matchCount === 1 ? "job matches" : "jobs match"} “${q}” by name or address`}
          </p>
        ) : null}

        <section aria-label="Your jobs">
          <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
            Your jobs
          </h3>
          {mine.length === 0 ? (
            <p className="text-[14px] text-text-muted">
              {q ? `None of your jobs match “${q}”.` : "No jobs assigned to you."}
            </p>
          ) : (
            <ul className="divide-y divide-[#eef2f6] overflow-hidden rounded-[16px] border border-border bg-surface">
              {mine.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  current={job.id === currentJobId}
                  loggedLine={loggedLine(entries, job.id, "Logged")}
                  onPick={() => onPick(job)}
                />
              ))}
            </ul>
          )}
        </section>

        {found.length > 0 ? (
          <section aria-label="Finished jobs">
            <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
              Finished jobs
            </h3>
            <ul className="divide-y divide-[#eef2f6] overflow-hidden rounded-[16px] border border-border bg-surface">
              {found.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  current={false}
                  finished
                  loggedLine={loggedLine(entries, job.id, "Last logged")}
                  onPick={() => onPick(job)}
                />
              ))}
            </ul>
          </section>
        ) : null}

        {history.kind === "failed" ? (
          <p className="text-[13px] text-state-danger" role="status">
            Finished jobs couldn&rsquo;t be checked just then — your own jobs still work.
          </p>
        ) : null}
      </div>
    </HoursSheet>
  );
}

function loggedLine(
  entries: ReadonlyArray<Pick<TimeEntry, "date" | "allocations">>,
  jobId: string,
  lead: string
): string | null {
  const d = lastLoggedDateForJob(entries, jobId);
  return d ? `${lead} ${dayDate(d)}` : null;
}

function JobRow({
  job,
  current,
  finished = false,
  loggedLine,
  onPick,
}: {
  job: HoursJob;
  current: boolean;
  finished?: boolean;
  loggedLine: string | null;
  onPick: () => void;
}): ReactNode {
  const isFinished = finished || isFinishedJob(job);
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        aria-current={current || undefined}
        data-testid={`hours-job-row-${job.id}`}
        className={cn(
          "flex min-h-[64px] w-full items-center gap-3 px-3 py-3 text-left",
          current ? "bg-brand-navy text-white" : "bg-surface text-text active:bg-surface-subtle"
        )}
      >
        <MapPin
          aria-hidden="true"
          className={cn("h-5 w-5 shrink-0", current ? "text-white" : "text-text-muted")}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-display text-[16px] font-bold">{job.name}</span>
            {isFinished ? (
              <span className="shrink-0 rounded-pill border border-border-strong px-2 py-0.5 text-[12px] font-semibold text-text-muted">
                finished
              </span>
            ) : null}
          </span>
          {job.address ? (
            <span
              className={cn(
                "block truncate text-[13px]",
                current ? "text-white/80" : "text-text-muted"
              )}
            >
              {job.address}
            </span>
          ) : null}
          {current ? (
            <span className="block text-[13px] font-semibold text-white/90">Your last job</span>
          ) : loggedLine ? (
            <span className="block text-[13px] text-text-muted">{loggedLine}</span>
          ) : null}
        </span>
      </button>
    </li>
  );
}
