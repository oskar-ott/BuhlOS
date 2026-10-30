"use client";

import { useState, type ReactNode } from "react";
import { Check, MapPin, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  dayDate,
  isFinishedJob,
  lastLoggedDateForJob,
  searchJobs,
  suburbOf,
  weekdayName,
  type HoursJob,
} from "@/domains/timesheets/hours-view";
import type { TimeEntry } from "@/domains/timesheets/types";
import { useJobHistorySearch } from "../useJobHistorySearch";
import { HoursSheet } from "./HoursSheet";

/**
 * Find another job (docs/phil-hours.md — the job sheet behind the 4th tile):
 * a search over name or address at the top (all jobs, finished ones too),
 * then "On your week now" — the tiled jobs, the picked one ticked — and
 * "Your other jobs · N" — every other assigned job with its suburb and the
 * day it was last logged (or "not logged yet"), scrolling inside the sheet.
 * Finished jobs are found only through search, tagged `finished`, for
 * callback work. Leave days are not jobs: they never appear here or in the
 * results; the footer points at the Sick day / Holiday buttons instead.
 */
export function FindJobSheet({
  open,
  onClose,
  date,
  tiles,
  jobs,
  currentJobId,
  entries,
  onPick,
  nested = false,
}: {
  open: boolean;
  onClose: () => void;
  date: string;
  /** The jobs with a tile right now, in tile order. */
  tiles: ReadonlyArray<HoursJob>;
  /** Every assigned job, by recency (`rankJobsByRecency`). */
  jobs: ReadonlyArray<HoursJob>;
  currentJobId: string | null;
  entries: ReadonlyArray<Pick<TimeEntry, "date" | "allocations">>;
  onPick: (job: HoursJob) => void;
  /** Opened from inside another sheet — stacks above it. */
  nested?: boolean;
}): ReactNode {
  const [query, setQuery] = useState("");
  const q = query.trim();
  const tileIds = new Set(tiles.map((j) => j.id));
  const onWeek = searchJobs(tiles, q);
  const otherJobs = jobs.filter((j) => !tileIds.has(j.id));
  const others = searchJobs(otherJobs, q);
  const history = useJobHistorySearch(query, open && q.length >= 2);
  const known = new Set([...tiles, ...jobs].map((j) => j.id));
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
  const matchCount = onWeek.length + others.length + found.length;
  const line = (job: HoursJob) => loggedLine(entries, job);

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
              placeholder="Job name or address, finished too"
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

        {jobs.length === 0 && tiles.length === 0 ? (
          <p className="text-[14px] text-text-muted">No jobs assigned to you.</p>
        ) : null}

        {onWeek.length > 0 ? (
          <JobSection label="On your week now" testId="hours-find-on-week">
            {onWeek.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                current={job.id === currentJobId}
                line={line(job)}
                onPick={() => onPick(job)}
              />
            ))}
          </JobSection>
        ) : null}

        {others.length > 0 ? (
          <JobSection label={`Your other jobs · ${others.length}`} testId="hours-find-others">
            {others.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                current={job.id === currentJobId}
                line={line(job)}
                onPick={() => onPick(job)}
              />
            ))}
          </JobSection>
        ) : q && otherJobs.length > 0 ? (
          <p className="text-[14px] text-text-muted">{`None of your other jobs match “${q}”.`}</p>
        ) : null}

        {found.length > 0 ? (
          <JobSection label="Finished jobs" testId="hours-find-finished">
            {found.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                current={false}
                finished
                line={line(job)}
                onPick={() => onPick(job)}
              />
            ))}
          </JobSection>
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

/** "Bondi · Logged Tue 13 Oct" / "Bondi · not logged yet" / "not logged yet". */
function loggedLine(
  entries: ReadonlyArray<Pick<TimeEntry, "date" | "allocations">>,
  job: HoursJob
): string {
  const d = lastLoggedDateForJob(entries, job.id);
  const logged = d ? `Logged ${dayDate(d)}` : "not logged yet";
  const suburb = suburbOf(job.address);
  return suburb ? `${suburb} · ${logged}` : logged;
}

function JobSection({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section aria-label={label} data-testid={testId}>
      <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
        {label}
      </h3>
      <ul className="divide-y divide-[#eef2f6] overflow-hidden rounded-[16px] border border-border bg-surface">
        {children}
      </ul>
    </section>
  );
}

function JobRow({
  job,
  current,
  finished = false,
  line,
  onPick,
}: {
  job: HoursJob;
  current: boolean;
  finished?: boolean;
  line: string;
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
        {current ? (
          <Check aria-hidden="true" className="h-5 w-5 shrink-0 text-white" />
        ) : (
          <MapPin aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-display text-[16px] font-bold">{job.name}</span>
            {isFinished ? (
              <span
                className={cn(
                  "shrink-0 rounded-pill border px-2 py-0.5 text-[12px] font-semibold",
                  current ? "border-white/60 text-white" : "border-border-strong text-text-muted"
                )}
              >
                finished
              </span>
            ) : null}
          </span>
          <span
            className={cn(
              "block truncate text-[13px]",
              current ? "text-white/80" : "text-text-muted"
            )}
          >
            {current ? `Picked · ${line}` : line}
          </span>
        </span>
      </button>
    </li>
  );
}
