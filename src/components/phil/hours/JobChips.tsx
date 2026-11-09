import type { ReactNode } from "react";
import { Building2, MapPin, Search, Wrench } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  chipJobs,
  isFinishedJob,
  weekdayName,
  type HoursJob,
} from "@/domains/timesheets/hours-view";
import type { TimeEntry } from "@/domains/timesheets/types";
import { isWorkPlaceId } from "@/domains/timesheets/work-places";

/**
 * The job chips (docs/phil-hours.md): a 2-column grid of the worker's jobs,
 * the last job first and picked ("Your last job"), plus a dashed "Find
 * another job" chip. A job found by search joins the grid as the picked chip,
 * full width, with its address · `finished job` · `Thursday only` — a pick
 * applies to the picked day only. Selected = navy fill + filled dot.
 *
 * Office and Workshop (owner pull 2026-11-06) are always last, before Find:
 * the worker's real jobs lead, the two no-job places follow.
 *
 * At most CHIP_JOB_LIMIT real jobs (owner pull 2026-11-09 — the chips sit in
 * the sticky panel and a long job list buried the week): the last job, then
 * the most recently logged, then by name; the picked and sent jobs always
 * show. The rest are one tap away in Find another job, which says how many.
 */
export function JobChips({
  jobs,
  pickedJobId,
  lastJobId,
  foundJob,
  date,
  sentJobId = null,
  entries,
  onPick,
  onFind,
}: {
  jobs: ReadonlyArray<HoursJob>;
  pickedJobId: string | null;
  lastJobId: string | null;
  /** A job found through search for this day (not in `jobs`). */
  foundJob?: HoursJob | null;
  date: string;
  /** In the Fix sheet: the job that was sent, marked "What you sent". */
  sentJobId?: string | null;
  /** The worker's days — ranks the chips by when each job was last logged. */
  entries?: ReadonlyArray<Pick<TimeEntry, "date" | "allocations">>;
  onPick: (jobId: string) => void;
  onFind: () => void;
}): ReactNode {
  const { shown, places, hidden } = chipJobs(
    jobs.filter((j) => j.id !== foundJob?.id),
    { lastJobId, keep: [pickedJobId, sentJobId], entries }
  );
  const ordered = [...shown, ...places];
  // Find fills the last cell when the grid has one free, else takes a row.
  const findWide = (ordered.length + (foundJob ? 2 : 0)) % 2 === 0;
  return (
    <div
      role="radiogroup"
      aria-label={`Job for ${weekdayName(date)}`}
      className="grid grid-cols-2 gap-2"
    >
      {foundJob ? (
        <Chip
          job={foundJob}
          active={pickedJobId === foundJob.id}
          onPick={() => onPick(foundJob.id)}
          wide
          caption={[
            foundJob.address,
            isFinishedJob(foundJob) ? "finished job" : null,
            `${weekdayName(date)} only`,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      ) : null}
      {ordered.map((job) => (
        <Chip
          key={job.id}
          job={job}
          active={pickedJobId === job.id}
          onPick={() => onPick(job.id)}
          caption={
            sentJobId === job.id
              ? "What you sent"
              : job.id === lastJobId
                ? isWorkPlaceId(job.id)
                  ? "Last time"
                  : "Your last job"
                : isFinishedJob(job)
                  ? "finished job"
                  : null
          }
        />
      ))}
      <button
        type="button"
        onClick={onFind}
        data-testid="hours-find-job"
        className={cn(
          "flex min-h-[56px] items-center justify-center gap-2 rounded-card border border-dashed border-border-strong px-3 py-2 text-text active:bg-surface-subtle",
          findWide && "col-span-2"
        )}
      >
        <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
        <span className="min-w-0 text-left">
          <span className="block font-display text-[15px] font-semibold leading-tight">
            Find another job
          </span>
          {hidden > 0 ? (
            <span className="block text-[12px] text-text-muted" data-testid="hours-find-job-more">
              {`${hidden} more ${hidden === 1 ? "job" : "jobs"} · search`}
            </span>
          ) : null}
        </span>
      </button>
    </div>
  );
}

function Chip({
  job,
  active,
  caption,
  wide = false,
  onPick,
}: {
  job: HoursJob;
  active: boolean;
  caption: string | null;
  wide?: boolean;
  onPick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={job.name}
      onClick={onPick}
      data-testid={`hours-job-chip-${job.id}`}
      className={cn(
        "flex min-h-[56px] items-center gap-2 rounded-card border px-3 py-2 text-left",
        wide && "col-span-2",
        active
          ? "border-brand-navy bg-brand-navy text-white"
          : "border-border-strong bg-surface text-text active:bg-surface-subtle"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
          active ? "border-white" : "border-border-strong"
        )}
      >
        {active ? (
          <span className="h-2 w-2 rounded-full bg-white" />
        ) : job.id === "place:office" ? (
          <Building2 className="h-2.5 w-2.5 text-text-muted" />
        ) : job.id === "place:workshop" ? (
          <Wrench className="h-2.5 w-2.5 text-text-muted" />
        ) : (
          <MapPin className="h-2.5 w-2.5 text-text-muted" />
        )}
      </span>
      <span className="min-w-0">
        <span className="line-clamp-2 font-display text-[15px] font-bold leading-tight">
          {job.name}
        </span>
        {caption ? (
          <span
            className={cn(
              "block truncate text-[12px]",
              active ? "text-white/80" : "text-text-muted"
            )}
          >
            {caption}
          </span>
        ) : null}
      </span>
    </button>
  );
}
