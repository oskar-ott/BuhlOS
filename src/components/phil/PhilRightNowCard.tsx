import Link from "next/link";
import type { Route } from "next";
import { AlertOctagon, ChevronRight, ClipboardCheck } from "lucide-react";
import { StatusChip, type StatusTone } from "@/components/ui/StatusChip";
import { statusLabel, statusTone } from "@/domains/jobs/format";
import type { Job, JobStatus } from "@/domains/jobs/types";
import { jobOpenWork, type JobOpenWorkKey } from "./philJobsListSignals";

// Bridge the jobs-domain tone vocabulary onto the shared StatusChip palette —
// the same mapping PhilJobsList uses, so the list and the lead card agree.
const JOBS_CHIP_TONE: Record<ReturnType<typeof statusTone>, StatusTone> = {
  neutral: "neutral",
  success: "success",
  warning: "warning",
};

// Same icon vocabulary as the jobs-list "open work on this site" chips.
const OPEN_WORK_ICON: Record<JobOpenWorkKey, typeof AlertOctagon> = {
  snags: AlertOctagon,
  itps: ClipboardCheck,
};

/**
 * The narrow view of a Job the lead card reads — so the card (and its test)
 * never depends on the full job shape.
 */
export type RightNowJob = Pick<Job, "id" | "name"> & {
  siteAddress?: string | null;
  status?: JobStatus;
  statsSnagsV2Active?: number;
  statsItpsActive?: number;
};

/**
 * The "Right Now" lead on /phil/my-day — the single assigned job the worker is
 * on, rendered as the navy accent hero from the approved A · Right Now
 * direction. Navy is used ONLY here, as an accent tile on the warm-paper page,
 * never as a page background.
 *
 * Honest by construction:
 *   - Address renders only when present (never a "—" placeholder).
 *   - Status is the real job status (statusLabel / statusTone), defaulting to
 *     Active exactly as the jobs list does for pre-status legacy rows.
 *   - "Open work" chips reuse jobOpenWork(): real, opt-in (?withStats=1) site
 *     counts (open snags · active ITPs) with neutral nouns, and NOTHING
 *     renders when the stats are absent — never a fabricated count or a
 *     guessed "all clear".
 *
 * Single-job only. A worker with 2+ assigned jobs gets the real PhilJobsList
 * instead — we never crown one job "you're on" without a real signal, because
 * there is no active-job state in the data.
 */
export function PhilRightNowCard({ job }: { job: RightNowJob }) {
  const address = (job.siteAddress ?? "").trim();
  const openWork = jobOpenWork(job);
  return (
    <Link
      href={`/phil/jobs/${encodeURIComponent(job.id)}` as Route}
      aria-label={`${job.name}, open job`}
      className="block overflow-hidden rounded-card border border-border shadow-card hover:brightness-[0.98]"
    >
      <div className="bg-brand-navy px-4 pb-4 pt-3.5 text-text-inverse">
        <p className="font-display text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-yellow">
          Today &middot; you&rsquo;re on
        </p>
        <p className="mt-1 font-display text-xl font-semibold leading-tight tracking-tight">
          {job.name}
        </p>
        {address ? (
          <p className="mt-0.5 text-sm text-text-inverse/70">{address}</p>
        ) : null}
      </div>
      <div className="space-y-3 bg-surface-raised px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <StatusChip tone={JOBS_CHIP_TONE[statusTone(job.status)]}>
            {statusLabel(job.status)}
          </StatusChip>
          <span className="inline-flex items-center gap-1 font-display text-sm font-semibold text-brand-navy">
            Open job
            <ChevronRight aria-hidden="true" className="h-4 w-4" />
          </span>
        </div>
        {openWork.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {openWork.map((s) => {
              const Icon = OPEN_WORK_ICON[s.key];
              return (
                <li
                  key={s.key}
                  className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface-subtle px-2.5 py-1 text-xs font-medium text-text-muted"
                >
                  <Icon aria-hidden="true" className="h-3.5 w-3.5" />
                  {s.label}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </Link>
  );
}
