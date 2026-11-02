import type { ReactNode } from "react";
import { MapPin, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  JOB_CHIPS_SHOWN,
  chipJobs,
  isFinishedJob,
  weekdayName,
  weekdayShort,
  type HoursJob,
} from "@/domains/timesheets/hours-view";

/**
 * The job tiles (docs/phil-hours.md): a 2×2 grid — the worker's last 3 jobs
 * (the last job first and picked, "Your last job") and a dashed 4th tile,
 * "More jobs", that opens Find another job for everything else. It never
 * grows past two rows, however many jobs there are (P10, owner 2026-11-02:
 * "the last 3 jobs … with the 4th tile being more jobs so it doesn't
 * saturate the screen"). Every worker works every active job, so a tile per
 * job was a page-filling wall.
 *
 * Which 3 (`chipJobs`): the last job, the day's pick, then the jobs this
 * worker logged most recently — never padded A–Z with jobs they've never
 * logged. A job found through More jobs takes the first tile for that day
 * (`finished job · Thu only` — a pick applies to the picked day only).
 * Selected = navy fill + filled dot.
 */
export function JobChips({
  jobs,
  recentJobIds = [],
  pickedJobId,
  lastJobId,
  foundJob,
  date,
  sentJobId = null,
  onPick,
  onFind,
}: {
  jobs: ReadonlyArray<HoursJob>;
  /** Job ids the worker logged, most recent first (`jobsByRecency`). */
  recentJobIds?: ReadonlyArray<string>;
  pickedJobId: string | null;
  lastJobId: string | null;
  /** A job found through search for this day — it takes the first tile. */
  foundJob?: HoursJob | null;
  date: string;
  /** In the Fix sheet: the job that was sent, marked "What you sent". */
  sentJobId?: string | null;
  onPick: (jobId: string) => void;
  onFind: () => void;
}): ReactNode {
  const shown = chipJobs({
    jobs,
    recentJobIds,
    lastJobId,
    pickedJobId,
    excludeJobId: foundJob?.id ?? null,
    limit: JOB_CHIPS_SHOWN - (foundJob ? 1 : 0),
  });
  const tiles = shown.length + (foundJob ? 1 : 0);
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
          caption={[isFinishedJob(foundJob) ? "finished job" : null, `${weekdayShort(date)} only`]
            .filter(Boolean)
            .join(" · ")}
        />
      ) : null}
      {shown.map((job) => (
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
        className={cn(
          "flex min-h-[56px] items-center justify-center gap-2 rounded-card border border-dashed border-border-strong px-3 font-display text-[15px] font-semibold text-text active:bg-surface-subtle",
          tiles === 0 && "col-span-2"
        )}
      >
        <Search aria-hidden="true" className="h-4 w-4 text-text-muted" />
        {tiles === 0 ? "Find a job" : "More jobs"}
      </button>
    </div>
  );
}

function Chip({
  job,
  active,
  caption,
  onPick,
}: {
  job: HoursJob;
  active: boolean;
  caption: string | null;
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
