import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import type { Job } from "@/domains/jobs/types";

/**
 * Admin job-hub read of the per-job Test & Tag register (#388) — renders the
 * `statsExpiredTags` / `statsExpiringTags` counts the jobs API has computed
 * (withStats=1) since the legacy estate, which nothing displayed post-cutover.
 *
 * Read-only by design: capture happens in the field (Phil register); the
 * office's cross-job action surface is the /gear compliance board (#305),
 * which this links to. Hidden entirely when the job has no flagged tags AND
 * no stats — absence of the card is the all-clear; an admin opening the hub
 * shouldn't scroll past an empty compliance card on every healthy job.
 */
export function JobTagsSummary({ job }: { job: Job }) {
  const expired = job.statsExpiredTags ?? 0;
  const expiring = job.statsExpiringTags ?? 0;
  if (expired === 0 && expiring === 0) return null;

  return (
    <Card
      role="region"
      aria-label="Tag register"
      // 2b: a live compliance breach earns the one danger left-rail on the page.
      className={expired > 0 ? "border-l-2 border-l-state-danger-dot" : undefined}
    >
      {/* Lean-reset replica 400-407 shows per-tag rows (tagNumber + appliance +
          Current/Overdue pill) and an "N tags" meta count; the hub's jobs read
          only carries the expired/expiring COUNTS (statsExpiredTags /
          statsExpiringTags) — so the rows and total are omitted rather than
          invented, and the real counts render as pills. */}
      <div className="flex items-start justify-between gap-3">
        <p className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-text">
          Tag register
        </p>
        <div className="flex shrink-0 gap-1.5">
          {expired > 0 ? <Pill tone="danger">{`${expired} expired`}</Pill> : null}
          {expiring > 0 ? <Pill tone="warning">{`${expiring} due in 14d`}</Pill> : null}
        </div>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-text-muted">
        From this job&rsquo;s register — the field adds and retests entries on the job page.
      </p>
      <Link
        href="/gear"
        className="mt-3 inline-block text-sm font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-4 focus:outline-none focus:ring-2 focus:ring-brand-navy"
      >
        Open the compliance board →
      </Link>
    </Card>
  );
}
