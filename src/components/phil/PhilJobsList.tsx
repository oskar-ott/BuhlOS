"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Route } from "next";
import { AlertOctagon, ChevronRight, ClipboardCheck, MapPin, Star } from "lucide-react";
import { PhilOfflineLink } from "./PhilOfflineLink";
import { StatusChip, type StatusTone } from "@/components/ui/StatusChip";
import { EmptyState } from "@/components/ui/EmptyState";
import { lastActivityCaption, statusLabel, statusTone } from "@/domains/jobs/format";
import { cn } from "@/lib/cn";
import type { Job } from "@/domains/jobs/types";
import {
  jobOpenWork,
  jobOpenWorkSummary,
  type JobOpenWorkKey,
} from "./philJobsListSignals";
import {
  readJobListPrefs,
  togglePin as togglePinPref,
  type JobListPrefs,
} from "./jobListPrefs";
import { orderJobList } from "./jobListOrder";

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

const EMPTY_PREFS: JobListPrefs = { recents: [], pinned: [] };

interface Props {
  initialJobs: ReadonlyArray<Job>;
  /**
   * The signed-in worker's id. Threaded from the page (the session viewer) so
   * the recent + pinned list is keyed per worker (#145). Defaults to "" so SSR
   * and the existing SSR render tests stay safe — with no userId the list is
   * exactly the name-first list it was before (no prefs read, no Recent group).
   */
  userId?: string;
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
 * Recent + pinned (#145, P14 — Phil remembers so the worker doesn't): a
 * worker on many sites re-finds the same 2-3 each day. Pinned jobs sort to
 * the top; recently-opened jobs sort next; everyone else stays name-first as
 * today (AC5 — place-first, name-first navigation is preserved). An automatic
 * "Recent" shortlist appears ABOVE the list ONLY for a worker with more than
 * ~3 jobs (P10 — zero clutter for a single-job worker). All client-only
 * localStorage keyed by userId; a job with no recents/pins just sorts
 * name-first (P7 — never a fabricated "recent"). Ordering is applied AFTER
 * mount so the SSR paint is the stable name-first list (no hydration flash for
 * a worker whose prefs would re-order rows).
 *
 * Tap target is the whole row (per doc 27 §8.4). The pin star is a separate
 * ≥44px control so a tap on it toggles the pin without opening the job. Empty
 * state speaks to the worker, not the system ("Ask your PM" — not "0 results").
 *
 * Server-side filtering at api/jobs.js:188-195 means the rows we render
 * are already scoped to the worker's assignedJobIds. The list is purely
 * presentational; no client-side permission logic.
 *
 * Cross-ref:
 *   docs/rebuild-audit/27-interface-usability-pass.md §4 + §8.4
 *   docs/rebuild-audit/24-phase-d-jobs-evidence-plan.md §6 Phil
 */
export function PhilJobsList({ initialJobs, userId = "" }: Props) {
  // Prefs are read AFTER mount (client-only). On the server / first paint we
  // hold empty prefs so the markup is the stable name-first list — the prior
  // behaviour exactly, which keeps the SSR render tests green and avoids a
  // hydration mismatch.
  const [prefs, setPrefs] = useState<JobListPrefs>(EMPTY_PREFS);

  useEffect(() => {
    if (!userId) return;
    setPrefs(readJobListPrefs(userId));
  }, [userId]);

  const onTogglePin = useCallback(
    (jobId: string) => {
      if (!userId) return;
      setPrefs(togglePinPref(userId, jobId));
    },
    [userId],
  );

  const { recentGroup, fullList, showRecentGroup } = useMemo(
    () => orderJobList(initialJobs, prefs),
    [initialJobs, prefs],
  );

  const pinnedSet = useMemo(() => new Set(prefs.pinned), [prefs.pinned]);
  const canPin = userId.length > 0;

  if (initialJobs.length === 0) {
    return (
      <EmptyState
        title="No jobs assigned yet"
        description="When admin or your leading hand puts you on a job, it'll show up here. Ask your PM if you think one is missing."
      />
    );
  }

  return (
    <div className="space-y-4">
      {showRecentGroup ? (
        <section aria-labelledby="phil-jobs-recent-heading" className="space-y-1.5">
          <h2
            id="phil-jobs-recent-heading"
            className="px-1 text-xs font-semibold uppercase tracking-wider text-text-muted"
          >
            Recent
          </h2>
          <ul
            data-testid="phil-jobs-recent"
            className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised"
          >
            {recentGroup.map((job) => (
              <li key={job.id}>
                <JobRow
                  job={job}
                  pinned={pinnedSet.has(job.id)}
                  canPin={canPin}
                  onTogglePin={onTogglePin}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ul
        data-testid="phil-jobs-all"
        className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised"
      >
        {fullList.map((job) => (
          <li key={job.id}>
            <JobRow
              job={job}
              pinned={pinnedSet.has(job.id)}
              canPin={canPin}
              onTogglePin={onTogglePin}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function JobRow({
  job,
  pinned,
  canPin,
  onTogglePin,
}: {
  job: Job;
  pinned: boolean;
  canPin: boolean;
  onTogglePin: (jobId: string) => void;
}) {
  const caption = lastActivityCaption(job);
  const address = (job.siteAddress ?? "").trim();
  // Real, opt-in (?withStats=1) site signals: open snags + active ITPs. Empty
  // when stats are absent, so the row degrades to exactly its prior look.
  const signals = jobOpenWork(job);
  const summary = jobOpenWorkSummary(signals);
  return (
    <div className="flex items-stretch">
      <PhilOfflineLink
        href={`/phil/jobs/${encodeURIComponent(job.id)}` as Route}
        className="flex min-h-[88px] flex-1 items-stretch gap-3 px-4 py-3 hover:bg-surface-subtle focus:bg-surface-subtle focus:outline-none"
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
                    className="inline-flex items-center gap-1 rounded-pill border border-border bg-surface px-2 py-0.5 text-[12px] font-medium text-text-muted"
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
            <span className="whitespace-nowrap text-[12px] uppercase tracking-wider text-text-muted">
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
      </PhilOfflineLink>

      {/* Pin/unpin — a separate, glove-sized (≥44px) control beside the row so a
          tap toggles the favourite without opening the job (P12 — discoverable
          by sight; P8 — gloved thumb). Only mounts once we have a userId to key
          the pref by, so SSR / no-session renders the row unchanged. */}
      {canPin ? (
        <button
          type="button"
          data-testid={`phil-job-pin-${job.id}`}
          aria-pressed={pinned}
          aria-label={pinned ? `Unpin ${job.name}` : `Pin ${job.name}`}
          onClick={() => onTogglePin(job.id)}
          className={cn(
            "flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center self-center",
            "rounded-card text-text-muted transition hover:bg-surface-subtle active:scale-95",
            "focus-visible:outline-brand-navy",
            pinned && "text-accent-yellow",
          )}
        >
          <Star
            aria-hidden="true"
            className="h-5 w-5"
            fill={pinned ? "currentColor" : "none"}
          />
        </button>
      ) : null}
    </div>
  );
}
