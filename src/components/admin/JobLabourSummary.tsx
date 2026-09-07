import type { Route } from "next";
import { AlertTriangle, Info } from "lucide-react";
import { Card, CardKicker } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import {
  formatDateLabel,
  formatHoursLabel,
  formatShortDateLabel,
  statusLabel,
} from "@/domains/timesheets/format";
import { costJobHours, listJobHoursRows, summariseJobHours } from "@/domains/jobs/job-hours";
import { formatMoneyCents } from "@/domains/jobs/profitability-client";
import { classifyTimeOverrun, timeOverrunView } from "@/domains/analytics/time-overrun";
import type { CostRateEntry } from "@/domains/cost-rates/schema";
import type { TimeEntry } from "@/domains/timesheets/types";

/**
 * Admin Job hub — Labour card: the labour spent on this job AND what it cost,
 * in one place (owner pull 2026-08-23; audit findings L3/L4/U1).
 *
 * Fed this job's SUBMITTED + APPROVED entries from /api/job-hours (#134,
 * recompute-on-read) plus, for an admin viewer, each worker's effective-dated
 * cost-rate history (api/cost-rates.js). The pure costJobHours runs the SAME
 * maths as api/job-profitability.js — approved hours × the rate effective on
 * the day worked — so the approved cost here is the Money card's labour
 * figure, never a second number. Awaiting-approval hours are costed separately
 * as "if approved", never mixed in.
 *
 * Every worker is listed (no six-worker cut), an unrated worker gets a "Set
 * rate" link straight to the employee record the rate lives on, and the
 * "all days" ledger shows the hours day by day — the amount of labour spent,
 * not just a total. When rates aren't readable (ratesByUser null) every cost
 * reads "—" and the card says "office only"; the page only renders this card
 * for the admin tier, because /api/job-hours is office data.
 *
 * The card never mutates: approvals live on the week board it links to.
 *
 * Cross-ref:
 *   src/domains/jobs/job-hours.ts — summarise / cost / rows (unit-tested)
 *   src/app/(admin)/hours/weekly/page.tsx — the week board (approvals)
 *   src/app/v2/jobs/[jobId]/page.tsx — the hub that renders this
 */

export function JobLabourSummary({
  entries,
  jobId,
  fetchError,
  estimatedHours = null,
  progressPct = null,
  ratesByUser = null,
  employeeIdByUserId = {},
}: {
  entries: ReadonlyArray<TimeEntry>;
  jobId: string;
  fetchError: string | null;
  /**
   * #343 time-overrun input: the job's estimated labour HOURS. `null` today for
   * every job, so the flag renders "No time estimate set" honestly.
   */
  estimatedHours?: number | null;
  /** #343 completion signal — the canonical pooled progress % (0–100 or null). */
  progressPct?: number | null;
  /** Effective-dated cost-rate history per worker account id, loaded by the
   *  admin page. null = rates unreadable → costs render "—". */
  ratesByUser?: Readonly<Record<string, ReadonlyArray<CostRateEntry>>> | null;
  /** users.json id → employees.json id, for the "Set rate" deep-link. */
  employeeIdByUserId?: Readonly<Record<string, string>>;
}) {
  const summary = summariseJobHours(entries, jobId);
  const costing = costJobHours(entries, jobId, ratesByUser);
  const rows = listJobHoursRows(entries, jobId);
  const pending = summary.pendingHours > 0;

  // #343 time-overrun flag: hours consumed (approved + submitted) vs the
  // canonical completion %, against an injected labour-HOURS estimate.
  const overrun = timeOverrunView(
    classifyTimeOverrun({
      estimatedHours,
      hoursConsumed: summary.approvedHours + summary.pendingHours,
      progressPct,
    })
  );

  const approvedCost = costing.approvedCostCents;
  const costValue =
    !costing.ratesKnown || approvedCost == null || approvedCost <= 0
      ? "—"
      : formatMoneyCents(approvedCost);
  const costCaption = !costing.ratesKnown
    ? "office only"
    : approvedCost == null || approvedCost <= 0
      ? summary.approvedHours > 0
        ? "no cost rates yet"
        : "no approved hours yet"
      : costing.unratedWorkers.length > 0
        ? `${costing.unratedWorkers.length} worker${costing.unratedWorkers.length === 1 ? "" : "s"} without a rate`
        : "approved hours × cost rate";
  const pendingCost = costing.pendingCostCents;
  const pendingCostValue =
    costing.ratesKnown && pendingCost != null && pendingCost > 0
      ? formatMoneyCents(pendingCost)
      : "—";

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <CardKicker>Labour</CardKicker>
        <a
          href={"/hours/weekly" as Route}
          className="text-sm font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-4 focus:outline-none focus:ring-2 focus:ring-brand-navy"
        >
          {pending ? "Approve on the week board →" : "Week board →"}
        </a>
      </div>

      {fetchError ? (
        <p
          className="mt-3 rounded-card border border-state-warning-subtle-border bg-state-warning-subtle-bg px-3 py-2 text-sm text-state-warning-subtle-text"
          role="alert"
        >
          Couldn&rsquo;t load hours for this job ({fetchError}). The week board still has the live
          queue.
        </p>
      ) : !summary.hasAny ? (
        // 2d — absence is designed: what will appear, and how it gets here.
        <p className="mt-3 text-sm text-text-muted">
          No hours logged yet. Days appear here as the crew logs time against this job in the field
          app, with approvals waiting for you on the week board.
        </p>
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Approved" value={formatHoursLabel(summary.approvedHours)} />
            <Tile
              label="Awaiting approval"
              value={formatHoursLabel(summary.pendingHours)}
              tone={pending ? "warning" : undefined}
            />
            <Tile
              label="Labour cost"
              value={costValue}
              muted={costValue === "—"}
              caption={costCaption}
            />
            <Tile
              label="If approved"
              value={pendingCostValue}
              muted={pendingCostValue === "—"}
              caption={pending ? "awaiting hours at cost" : "nothing awaiting"}
            />
          </dl>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm" data-testid="labour-workers">
              <thead>
                <tr className="text-left font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted">
                  <th className="pb-1.5 pr-2 font-medium">Worker</th>
                  <th className="pb-1.5 pr-2 text-right font-medium">Approved</th>
                  <th className="pb-1.5 pr-2 text-right font-medium">Awaiting</th>
                  {costing.ratesKnown ? (
                    <th className="pb-1.5 text-right font-medium">Cost</th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {costing.workers.map((w) => (
                  <tr key={w.userId} className="border-t border-border">
                    <td className="py-1.5 pr-2 font-medium text-text">{w.userName}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {w.approvedHours > 0 ? formatHoursLabel(w.approvedHours) : "—"}
                    </td>
                    <td
                      className={cn(
                        "py-1.5 pr-2 text-right tabular-nums",
                        w.pendingHours > 0 ? "text-state-warning-subtle-text" : "text-text-muted"
                      )}
                    >
                      {w.pendingHours > 0 ? formatHoursLabel(w.pendingHours) : "—"}
                    </td>
                    {costing.ratesKnown ? (
                      <td className="py-1.5 text-right tabular-nums">
                        {w.approvedCostCents != null && w.approvedCostCents > 0 ? (
                          <>
                            {formatMoneyCents(w.approvedCostCents)}
                            {!w.rated ? (
                              <span className="block text-xs text-text-muted">
                                some days unrated
                              </span>
                            ) : null}
                          </>
                        ) : !w.rated ? (
                          <a
                            href={
                              (employeeIdByUserId[w.userId]
                                ? `/employees/${encodeURIComponent(employeeIdByUserId[w.userId]!)}`
                                : "/employees") as Route
                            }
                            className="text-xs font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2 focus:outline-none focus:ring-2 focus:ring-brand-navy"
                          >
                            Set rate →
                          </a>
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <details className="mt-4 rounded-[4px] border border-border bg-surface-subtle px-4 py-2">
            <summary className="cursor-pointer text-sm font-medium text-text">
              All days on this job · {rows.length}
            </summary>
            <ul className="mt-2 divide-y divide-border text-sm" data-testid="labour-days">
              {rows.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="w-24 shrink-0 tabular-nums text-text-muted">
                    {formatShortDateLabel(r.date)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-text">{r.userName}</span>
                  <span className="tabular-nums text-text">{formatHoursLabel(r.hours)}</span>
                  <span
                    className={cn(
                      "w-20 text-right font-mono text-xs uppercase tracking-[0.12em]",
                      r.status === "submitted"
                        ? "text-state-warning-subtle-text"
                        : "text-text-muted"
                    )}
                  >
                    {statusLabel(r.status)}
                  </span>
                </li>
              ))}
            </ul>
          </details>

          {summary.latestDate ? (
            <p className="mt-3 text-xs text-text-muted">
              Latest entry {formatDateLabel(summary.latestDate)} · cost = hours × each
              worker&rsquo;s loaded cost rate on the day worked; approved hours feed the Money card.
            </p>
          ) : null}
        </>
      )}

      {/* #343 — time-overrun early-warning. Honest by construction: with no
          labour-hours estimate this is a muted "No time estimate set" note. */}
      {overrun.show ? (
        overrun.tone === "warning" || overrun.tone === "critical" ? (
          <p
            className={`mt-3 flex items-start gap-1.5 rounded-card border px-3 py-2 text-sm ${
              overrun.tone === "critical"
                ? "border-state-danger-subtle-border bg-state-danger-subtle-bg text-state-danger-subtle-text"
                : "border-state-warning-subtle-border bg-state-warning-subtle-bg text-state-warning-subtle-text"
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
    </Card>
  );
}

function Tile({
  label,
  value,
  caption,
  tone,
  muted,
}: {
  label: string;
  value: string;
  caption?: string;
  tone?: "warning";
  muted?: boolean;
}) {
  const warn = tone === "warning";
  return (
    <div
      className={
        warn
          ? "rounded-[4px] border border-state-warning-subtle-border bg-state-warning-subtle-bg px-4 py-3"
          : "rounded-[4px] border border-border bg-surface-subtle px-4 py-3"
      }
    >
      <dt
        className={cn(
          "font-mono text-xs font-medium uppercase tracking-[0.14em]",
          warn ? "text-state-warning-subtle-text" : "text-text-muted"
        )}
      >
        {label}
      </dt>
      <dd
        className={cn(
          "mt-1 font-display text-[22px] font-bold tabular-nums leading-none",
          warn ? "text-state-warning-subtle-text" : muted ? "text-text-muted" : "text-text"
        )}
      >
        {value}
      </dd>
      {caption ? <p className="mt-1 text-xs text-text-muted">{caption}</p> : null}
    </div>
  );
}
