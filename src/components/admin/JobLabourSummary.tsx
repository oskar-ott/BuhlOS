import type { Route } from "next";
import { ArrowRight, CheckCircle2, Clock } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { formatDateLabel, formatHoursLabel } from "@/domains/timesheets/format";
import {
  deriveJobHoursAttention,
  groupJobHoursByWorker,
  summariseJobHours,
} from "@/domains/jobs/job-hours";
import type { TimeEntry } from "@/domains/timesheets/types";

/**
 * Admin Job hub — Labour / Hours summary.
 *
 * A read-only "what labour is waiting for me to approve on this job?" card.
 * It is fed the approver SUBMITTED queue (the same data the /hours/approvals
 * surface loads) and sums the allocations pointing at THIS job, so every
 * number is real, blob-derived time-entry data — never a fabricated total.
 *
 * Deliberately scoped to PENDING approval, not a full ledger: time entries are
 * stored per-user-per-day with no per-job index, so a full approved/rejected/
 * weekly rollup would mean scanning every user's blobs once per status on
 * every hub view. That heavier rollup (and the time-entry approval actions)
 * stays on the existing /hours/approvals surface, which this card deep-links
 * to. The card never mutates: no approve/reject, no edit, no payroll push.
 *
 * Empty state is honest and precise — "no hours awaiting approval", never "no
 * hours logged" — so a job whose hours are all already approved doesn't read
 * as having had no labour.
 *
 * Cross-ref:
 *   src/domains/jobs/job-hours.ts — the pure derivation (unit-tested)
 *   src/app/(admin)/hours/approvals/page.tsx — the full approvals ledger
 *   src/app/v2/jobs/[jobId]/page.tsx — the hub that renders this
 */

const WORKER_LIMIT = 6;

function LabourStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-card border border-border bg-surface px-3 py-2">
      <div className="min-w-0">
        <div className="font-display text-base leading-tight text-text">{value}</div>
        <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
          {label}
        </div>
      </div>
    </div>
  );
}

export function JobLabourSummary({
  entries,
  jobId,
  fetchError,
}: {
  entries: ReadonlyArray<TimeEntry>;
  jobId: string;
  fetchError: string | null;
}) {
  const summary = summariseJobHours(entries, jobId);
  const attention = deriveJobHoursAttention(summary);
  const workers = groupJobHoursByWorker(entries, jobId).slice(0, WORKER_LIMIT);

  return (
    <Card>
      <div className="flex items-center gap-2">
        <Clock aria-hidden="true" className="h-5 w-5 text-text-muted" />
        <CardTitle>Labour</CardTitle>
      </div>
      <CardDescription className="mt-1">
        Hours submitted against this job and awaiting office approval. The full
        ledger — approved, rejected and weekly totals — lives in Hours
        approvals.
      </CardDescription>

      {fetchError ? (
        <p
          className="mt-3 rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          role="alert"
        >
          Couldn&rsquo;t load hours for this job ({fetchError}). Open Hours
          approvals for the live queue.
        </p>
      ) : !attention.pending ? (
        <p className="mt-3 inline-flex items-center gap-1.5 text-sm text-emerald-700">
          <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
          No hours are awaiting approval on this job.
        </p>
      ) : (
        <>
          <dl className="mt-3 flex flex-wrap gap-2">
            <LabourStat
              label="Awaiting approval"
              value={formatHoursLabel(summary.pendingHours)}
            />
            <LabourStat
              label={summary.pendingCount === 1 ? "Entry" : "Entries"}
              value={String(summary.pendingCount)}
            />
            {summary.latestDate ? (
              <LabourStat label="Latest" value={formatDateLabel(summary.latestDate)} />
            ) : null}
          </dl>

          {workers.length > 0 ? (
            <div className="mt-3">
              <p className="font-display text-[11px] uppercase tracking-wider text-text-muted">
                By worker
              </p>
              <ul className="mt-1 flex flex-wrap gap-2">
                {workers.map((w) => (
                  <li
                    key={w.userId}
                    className="inline-flex items-center gap-1.5 rounded-card border border-border bg-surface px-2.5 py-1 text-xs"
                  >
                    <span className="font-display font-semibold text-text">
                      {w.userName}
                    </span>
                    <span className="text-text-muted">{formatHoursLabel(w.hours)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}

      <div className="mt-4">
        <a
          href={"/hours/approvals" as Route}
          className="inline-flex items-center gap-1 text-sm font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-4 focus:outline-none focus:ring-2 focus:ring-brand-navy"
        >
          Review hours approvals
          <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
        </a>
      </div>
    </Card>
  );
}
