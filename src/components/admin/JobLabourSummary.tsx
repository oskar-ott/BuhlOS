import type { Route } from "next";
import { AlertTriangle, ArrowRight, CheckCircle2, Clock, Info } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { formatDateLabel, formatHoursLabel } from "@/domains/timesheets/format";
import {
  groupJobHoursByWorker,
  summariseJobHours,
} from "@/domains/jobs/job-hours";
import { classifyTimeOverrun, timeOverrunView } from "@/domains/analytics/time-overrun";
import type { TimeEntry } from "@/domains/timesheets/types";

/**
 * Admin Job hub — Labour / Hours summary.
 *
 * A read-only "how much labour is on this job?" card. It is fed this job's
 * SUBMITTED + APPROVED entries from /api/job-hours (#134, recompute-on-read) and
 * sums the allocations pointing at THIS job, so every number is real,
 * blob-derived time-entry data — never a fabricated total. The pure
 * summariseJobHours buckets them by status into approved vs awaiting-approval.
 *
 * Scope: approved + pending only (rejected/draft excluded). There is no per-job
 * index, so this recomputes from a full users/ scan on read — the heavier
 * weekly/rejected ledger and the approval actions stay on /hours/approvals,
 * which this card deep-links to. The card never mutates: no approve/reject, no
 * edit, no payroll push.
 *
 * Empty state is honest and precise — "no labour recorded yet" — so the card
 * never fabricates activity.
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
  estimatedHours = null,
  progressPct = null,
}: {
  entries: ReadonlyArray<TimeEntry>;
  jobId: string;
  fetchError: string | null;
  /**
   * #343 time-overrun input: the job's estimated labour HOURS. `null` today for
   * every job (the quote→job converter drops per-line estimatedHours and
   * `labourEstimate` is dollars), so the flag renders "No time estimate set"
   * honestly rather than guessing. The moment jobs seed a real hours estimate,
   * this prop carries it with no other change here.
   */
  estimatedHours?: number | null;
  /** #343 completion signal — the canonical pooled progress % (0–100 or null). */
  progressPct?: number | null;
}) {
  // /api/job-hours feeds submitted + approved; summariseJobHours buckets by
  // status (it ignores any other status defensively). Numbers are real, never
  // fabricated; the per-worker breakdown is over the same set.
  const summary = summariseJobHours(entries, jobId);
  const workers = groupJobHoursByWorker(entries, jobId).slice(0, WORKER_LIMIT);

  // #343 time-overrun flag: hours consumed (approved + submitted, exactly the
  // scope this card already loads — never rejected/draft) vs the canonical
  // completion %, against an injected labour-HOURS estimate. Pure classifier;
  // renders honestly with no estimate rather than fabricating one.
  const overrun = timeOverrunView(
    classifyTimeOverrun({
      estimatedHours,
      hoursConsumed: summary.approvedHours + summary.pendingHours,
      progressPct,
    }),
  );

  return (
    <Card>
      <div className="flex items-center gap-2">
        <Clock aria-hidden="true" className="h-5 w-5 text-text-muted" />
        <CardTitle>Labour</CardTitle>
      </div>
      <CardDescription className="mt-1">
        Approved and submitted hours on this job, recomputed on read. Rejected
        and weekly totals live in Hours approvals.
      </CardDescription>

      {fetchError ? (
        <p
          className="mt-3 rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          role="alert"
        >
          Couldn&rsquo;t load hours for this job ({fetchError}). Open Hours
          approvals for the live queue.
        </p>
      ) : !summary.hasAny ? (
        <p className="mt-3 inline-flex items-center gap-1.5 text-sm text-emerald-700">
          <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
          No labour recorded on this job yet.
        </p>
      ) : (
        <>
          <dl className="mt-3 flex flex-wrap gap-2">
            <LabourStat label="Approved" value={formatHoursLabel(summary.approvedHours)} />
            <LabourStat
              label="Awaiting approval"
              value={formatHoursLabel(summary.pendingHours)}
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

      {/* #343 — time-overrun early-warning. Honest by construction: with no
          labour-hours estimate (every job today) this is a muted "No time
          estimate set" note, never a fabricated ratio. When an estimate exists
          and hours outpace progress it escalates to a warning/critical line
          showing its exact math. */}
      {overrun.show ? (
        overrun.tone === "warning" || overrun.tone === "critical" ? (
          <p
            className={`mt-3 flex items-start gap-1.5 rounded-card border px-3 py-2 text-sm ${
              overrun.tone === "critical"
                ? "border-red-200 bg-red-50 text-red-900"
                : "border-amber-200 bg-amber-50 text-amber-900"
            }`}
            role="alert"
          >
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <span className="font-display font-semibold">{overrun.headline}</span>
              {" — "}
              {overrun.detail}
            </span>
          </p>
        ) : (
          <p className="mt-3 flex items-start gap-1.5 text-sm text-text-muted">
            <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <span className="font-medium text-text">{overrun.headline}</span> — {overrun.detail}
            </span>
          </p>
        )
      ) : null}

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
