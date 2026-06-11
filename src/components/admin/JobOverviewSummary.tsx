import type { Route } from "next";
import {
  AlertOctagon,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  TrendingUp,
  Users,
} from "lucide-react";
import { Card, CardTitle } from "@/components/ui/Card";
import { lastActivityCaption } from "@/domains/jobs/format";
import { progressCaption as canonicalProgressCaption, progressPct as canonicalProgressPct } from "@/domains/jobs/progress";
import { deriveJobAttention, type JobAttentionKey } from "@/domains/jobs/attention";
import type { Job } from "@/domains/jobs/types";

/**
 * Admin Job hub — operational status summary.
 *
 * Renders the at-a-glance job state the hub already fetches (via
 * /api/jobs?id=&withStats=1) but previously discarded: job health (progress %,
 * field-crew count, "updated" recency) and a "Needs attention" strip derived
 * from the real stats by deriveJobAttention(). Every number here is real,
 * blob-derived data on the loaded `Job` — nothing is fabricated, and zero
 * counts collapse to an honest "All clear" rather than empty chips.
 *
 * Read-only: the attention chips deep-link to the matching per-job tab; this
 * card never mutates. Sits directly under the header so an admin can read the
 * job's state in seconds before scrolling into Build/Site/Sections.
 *
 * Cross-ref:
 *   src/domains/jobs/attention.ts — the pure derivation (unit-tested)
 *   src/app/v2/jobs/[jobId]/page.tsx — the hub that renders this
 */

const ATTENTION_ICON: Record<JobAttentionKey, typeof Camera> = {
  evidence: Camera,
  snags: AlertOctagon,
  itps: ClipboardCheck,
};

function HealthStat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-card border border-border bg-surface px-3 py-2">
      <span aria-hidden="true" className="shrink-0 text-text-muted">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="font-display text-base leading-tight text-text">{value}</div>
        <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
          {label}
        </div>
      </div>
    </div>
  );
}

function progressCaptionParts(counts: { total: number; complete: number }) {
  return { caption: canonicalProgressCaption(counts), pct: canonicalProgressPct(counts) };
}

export function JobOverviewSummary({ job }: { job: Job }) {
  const attention = deriveJobAttention(job);
  // #198 canonical progress: counts first, % only where a total exists.
  // statsPct stays as the fallback for payloads without the counts fields.
  const counts =
    typeof job.statsTasksTotal === "number" && typeof job.statsTasksComplete === "number"
      ? progressCaptionParts({ total: job.statsTasksTotal, complete: job.statsTasksComplete })
      : null;
  const pct =
    counts !== null
      ? counts.pct
      : typeof job.statsPct === "number"
        ? Math.round(job.statsPct)
        : null;
  const crew = typeof job.statsCrewCount === "number" ? job.statsCrewCount : null;
  const updated = lastActivityCaption(job);
  const jobIdEnc = encodeURIComponent(job.id);

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <CardTitle>Status</CardTitle>
        {updated ? <span className="text-xs text-text-muted">{updated}</span> : null}
      </div>

      {/* Job health — only the signals we genuinely have on the loaded job. */}
      {pct !== null || crew !== null || counts !== null ? (
        <dl className="mt-3 flex flex-wrap gap-2">
          {counts !== null && counts.pct === null ? (
            <HealthStat
              icon={<TrendingUp className="h-4 w-4" />}
              label="Tasks"
              value="No tasks yet"
            />
          ) : pct !== null ? (
            <HealthStat
              icon={<TrendingUp className="h-4 w-4" />}
              label="Complete"
              value={counts !== null ? `${counts.caption} · ${pct}%` : `${pct}%`}
            />
          ) : null}
          {crew !== null ? (
            <HealthStat
              icon={<Users className="h-4 w-4" />}
              label="Field crew"
              value={String(crew)}
            />
          ) : null}
        </dl>
      ) : null}

      {/* Needs attention — real derived issues only; honest "All clear". */}
      <div className="mt-4">
        <p className="font-display text-[11px] uppercase tracking-wider text-text-muted">
          Needs attention
        </p>
        {attention.allClear ? (
          <p className="mt-2 inline-flex items-center gap-1.5 text-sm text-emerald-700">
            <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
            All clear — nothing needs office action right now.
          </p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {attention.items.map((item) => {
              const Icon = ATTENTION_ICON[item.key];
              return (
                <li key={item.key}>
                  <a
                    href={`/v2/jobs/${jobIdEnc}/${item.key}` as Route}
                    aria-label={`${item.count} ${item.label} — open`}
                    className="inline-flex items-center gap-1.5 rounded-card border border-border bg-surface px-3 py-1.5 text-sm transition-colors hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy"
                  >
                    <Icon aria-hidden="true" className="h-4 w-4 text-text-muted" />
                    <span className="font-display font-semibold text-text">{item.count}</span>
                    <span className="text-text-muted">{item.label}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
