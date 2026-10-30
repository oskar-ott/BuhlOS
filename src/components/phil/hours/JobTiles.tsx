import type { ReactNode } from "react";
import { MapPin, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  findTileWords,
  isFinishedJob,
  weekdayName,
  type HoursJob,
} from "@/domains/timesheets/hours-view";

/**
 * The job tiles (docs/phil-hours.md): a fixed 2-column grid of at most
 * JOB_TILE_CAP job tiles plus a 4th "Find another job" tile — never more,
 * whatever the job count, so the dock is the same height for 3 jobs as for
 * 30 and the week and the Log button stay on screen (P10). WHICH jobs get a
 * tile is `jobTiles` in hours-view.ts (recency; a job found through search
 * takes the oldest unpicked tile for the session); this only draws them.
 *
 * The tiles are a radiogroup labelled "Job for <day>"; the Find tile is a
 * separate button whose accessible name carries the count ("Find another
 * job, 6 more of yours"). Selected = navy fill + filled dot, never colour
 * alone. Tiles are ≥ 52px tall and grow with the text size — labels wrap,
 * the cap holds.
 */
export function JobTiles({
  tiles,
  more,
  pickedJobId,
  lastJobId,
  sentJobId = null,
  date,
  onPick,
  onFind,
}: {
  /** At most JOB_TILE_CAP jobs, in tile order (from `jobTiles`). */
  tiles: ReadonlyArray<HoursJob>;
  /** The worker's own jobs without a tile — the Find tile's "N more of yours". */
  more: number;
  pickedJobId: string | null;
  /** The last logged job — its tile says "Your last job". */
  lastJobId: string | null;
  /** In the Fix sheet: the job that was sent, marked "What you sent". */
  sentJobId?: string | null;
  date: string;
  onPick: (jobId: string) => void;
  onFind: () => void;
}): ReactNode {
  const find = findTileWords(more);
  return (
    <div className="grid grid-cols-2 gap-2" data-testid="hours-job-tiles">
      <div role="radiogroup" aria-label={`Job for ${weekdayName(date)}`} className="contents">
        {tiles.map((job) => (
          <Tile
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
      </div>
      <button
        type="button"
        onClick={onFind}
        aria-label={find.ariaLabel}
        data-testid="hours-find-job"
        className="flex min-h-[52px] items-center gap-2 rounded-card border border-dashed border-border-strong px-3 py-2 text-left text-text active:bg-surface-subtle"
      >
        <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
        <span className="min-w-0">
          <span className="block font-display text-[15px] font-semibold leading-tight">
            {find.label}
          </span>
          {find.sub ? (
            <span className="block text-[12px] text-text-muted" data-testid="hours-find-job-more">
              {find.sub}
            </span>
          ) : null}
        </span>
      </button>
    </div>
  );
}

function Tile({
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
      data-testid={`hours-job-tile-${job.id}`}
      className={cn(
        "flex min-h-[52px] items-center gap-2 rounded-card border px-3 py-2 text-left",
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
