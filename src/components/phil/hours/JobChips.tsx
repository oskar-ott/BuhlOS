import type { ReactNode } from "react";
import { MapPin, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { isFinishedJob, weekdayName, type HoursJob } from "@/domains/timesheets/hours-view";

/**
 * The job chips (docs/phil-hours.md): a 2-column grid of the worker's jobs,
 * the last job first and picked ("Your last job"), plus a dashed "Find
 * another job" chip. A job found by search joins the grid as the picked chip,
 * full width, with its address · `finished job` · `Thursday only` — a pick
 * applies to the picked day only. Selected = navy fill + filled dot.
 */
export function JobChips({
  jobs,
  pickedJobId,
  lastJobId,
  foundJob,
  date,
  sentJobId = null,
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
  onPick: (jobId: string) => void;
  onFind: () => void;
}): ReactNode {
  const ordered = [...jobs].sort((a, b) =>
    a.id === lastJobId ? -1 : b.id === lastJobId ? 1 : a.name.localeCompare(b.name)
  );
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
                ? "Your last job"
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
        className="flex min-h-[56px] items-center justify-center gap-2 rounded-card border border-dashed border-border-strong px-3 font-display text-[15px] font-semibold text-text active:bg-surface-subtle"
      >
        <Search aria-hidden="true" className="h-4 w-4 text-text-muted" />
        Find another job
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
