import type { Route } from "next";
import {
  AlertOctagon,
  ArrowRight,
  ArrowRightLeft,
  Camera,
  ClipboardCheck,
  History,
  Inbox,
  Package,
} from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { actionLabel } from "@/domains/audit-log/format";
import { relativeWhen } from "@/domains/jobs/format";
import { selectRecentActivity } from "@/domains/jobs/job-activity";
import type { AuditLogEntry, AuditTargetType } from "@/domains/audit-log/types";

/**
 * Admin Job hub — Recent activity.
 *
 * A compact preview of the job's real, append-only audit-log: the latest few
 * evidence captures/reviews, snag transitions, ITP milestones, observation
 * conversions and material-request changes. It reads the SAME source as the
 * full /v2/jobs/[id]/history feed (GET /api/audit-log?jobId=&scope=job), so it
 * never invents events or a parallel timeline — it just trims the stream to
 * the newest entries and deep-links to the full feed.
 *
 * Unlike the history page's JobActivityFeed (a stateful "use client" component
 * with filter chips), this is a static server-rendered preview — right for a
 * scannable Overview card.
 *
 * Honest empty state: "No recent activity yet." Nothing is fabricated.
 *
 * Cross-ref:
 *   src/domains/jobs/job-activity.ts — the pure selection (unit-tested)
 *   src/components/admin/JobActivityFeed.tsx — the full-page feed (history tab)
 *   src/app/v2/jobs/[jobId]/history/page.tsx — the full feed's route
 */

const PREVIEW_LIMIT = 5;

function iconForTargetType(t: AuditTargetType) {
  switch (t) {
    case "evidence":
      return Camera;
    case "snag":
      return AlertOctagon;
    case "itp_template":
    case "itp_instance":
      return ClipboardCheck;
    case "observation":
      return ArrowRightLeft;
    case "material_request":
      return Package;
    default:
      return Inbox;
  }
}

export function JobRecentActivity({
  entries,
  jobId,
  fetchError,
}: {
  entries: ReadonlyArray<AuditLogEntry>;
  jobId: string;
  fetchError: string | null;
}) {
  const { items, total, hasMore } = selectRecentActivity(entries, PREVIEW_LIMIT);
  const historyHref = `/v2/jobs/${encodeURIComponent(jobId)}/history` as Route;
  const extra = total - items.length;

  return (
    <Card>
      <div className="flex items-center gap-2">
        <History aria-hidden="true" className="h-5 w-5 text-text-muted" />
        <CardTitle>Recent activity</CardTitle>
      </div>
      <CardDescription className="mt-1">
        The latest captures, snag transitions, ITP sign-offs and observation
        conversions on this job.
      </CardDescription>

      {fetchError ? (
        <p
          className="mt-3 rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          role="alert"
        >
          Couldn&rsquo;t load activity for this job ({fetchError}). Open the
          activity feed to retry.
        </p>
      ) : total === 0 ? (
        <p className="mt-3 rounded-card border border-dashed border-border bg-surface-subtle px-3 py-4 text-sm text-text-muted">
          No recent activity yet. When the field captures evidence, raises a
          snag or signs off an ITP, it lands here.
        </p>
      ) : (
        <ol className="mt-3 space-y-2" aria-label="Recent job activity">
          {items.map((e) => {
            const Icon = iconForTargetType(e.targetType);
            return (
              <li key={e.id} className="flex gap-3 rounded-card border border-border bg-surface p-3">
                <div className="mt-0.5 shrink-0 rounded-card border border-border bg-surface-subtle p-1.5">
                  <Icon aria-hidden="true" className="h-4 w-4 text-text-muted" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="font-display font-semibold text-text">
                      {actionLabel(e.action)}
                    </span>
                    <span className="text-xs text-text-muted">
                      by {e.actorName}
                      {e.actorRole ? ` · ${e.actorRole}` : ""}
                    </span>
                    <span className="text-xs text-text-muted">· {relativeWhen(e.ts)}</span>
                  </p>
                  {e.summary ? (
                    <p className="mt-0.5 line-clamp-1 text-sm text-text-muted">{e.summary}</p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <div className="mt-4">
        <a
          href={historyHref}
          className="inline-flex items-center gap-1 text-sm font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-4 focus:outline-none focus:ring-2 focus:ring-brand-navy"
        >
          {hasMore && extra > 0 ? `View all activity (+${extra} more)` : "View all activity"}
          <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
        </a>
      </div>
    </Card>
  );
}
