import Link from "next/link";
import type { Route } from "next";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { CompanyStatStrip } from "@/components/admin/CompanyStatStrip";
import { buildQaSummary } from "@/domains/company/summary";
import type { QaStatusResult } from "@/server/itp/qa-status";
import type { QaJobRow } from "@/domains/itp/qa-rollup";

/**
 * Read-only cross-job QA status board (#290, first increment) — the office
 * "QA exposure" readback: per active job, the ITP instance counts by status,
 * open points, oldest unactioned age, and what's awaiting sign-off, worst-first,
 * with drill-through to the existing per-job ITP surface.
 *
 * Pure presentational (no hooks/fetch/state) — server-renders + unit-tests with
 * `renderToString`. It renders from the server-derived `QaStatusResult`; it never
 * recomputes a rollup. Honest empties: a job with no ITPs is a GAP ("No ITPs
 * attached"), never all-clear; jobs whose blob couldn't be read are surfaced, not
 * hidden.
 */
export function QaStatusBoard({ result }: { result: QaStatusResult }) {
  if (!result.ok) {
    return (
      <div className="mx-auto max-w-5xl">
        <Card role="alert">
          <CardTitle>QA status</CardTitle>
          <CardDescription className="mt-2">Could not load the QA dashboard.</CardDescription>
        </Card>
      </div>
    );
  }

  const { dashboard, failedJobs } = result;
  const { rows } = dashboard;
  const summary = buildQaSummary(dashboard);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <Card>
        <CardTitle>QA status</CardTitle>
        <CardDescription className="mt-1">
          ITP / QA health across active jobs. Worst-first — chase the oldest
          unwitnessed checks before they become audit findings. A check that&rsquo;s
          recorded but not independently signed off is awaiting sign-off, never
          &ldquo;done&rdquo;.
        </CardDescription>
        {failedJobs.length > 0 ? (
          <p className="mt-2 text-xs text-state-warning" role="alert">
            {failedJobs.length} job{failedJobs.length === 1 ? "" : "s"}&rsquo; QA couldn&rsquo;t be
            read and {failedJobs.length === 1 ? "is" : "are"} not counted.
          </p>
        ) : null}
      </Card>

      <CompanyStatStrip
        label="QA at a glance"
        subline={summary.subline}
        tiles={summary.tiles}
      />

      {rows.length === 0 ? (
        <Card>
          <CardDescription>No active jobs to report QA on.</CardDescription>
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-text-muted">
                <th className="py-2 pr-3 font-medium">Job</th>
                <th className="px-2 py-2 font-medium">Pending</th>
                <th className="px-2 py-2 font-medium">In&nbsp;progress</th>
                <th className="px-2 py-2 font-medium">Witnessed</th>
                <th className="px-2 py-2 font-medium">Signed&nbsp;off</th>
                <th className="px-2 py-2 font-medium">Open&nbsp;pts</th>
                <th className="px-2 py-2 font-medium">Oldest&nbsp;active</th>
                <th className="px-2 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <QaRow key={row.jobId} row={row} />
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-text-muted">
            One blob read per active job (no cross-job index yet) — see the QA
            readback doc.
          </p>
        </Card>
      )}
    </div>
  );
}

function QaRow({ row }: { row: QaJobRow }) {
  const { rollup } = row;
  const href = `/v2/jobs/${encodeURIComponent(row.jobId)}/itps` as Route;
  const name = (
    <Link
      href={href}
      className="font-medium text-text underline decoration-accent-yellow decoration-2 underline-offset-2"
    >
      {row.jobName}
    </Link>
  );

  // Honest gap: a job with no ITPs is NOT all-clear.
  if (rollup.total === 0) {
    return (
      <tr className="border-b border-border/60">
        <td className="py-2 pr-3">{name}</td>
        <td className="px-2 py-2 text-text-muted" colSpan={7}>
          No ITPs attached
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-border/60">
      <td className="py-2 pr-3">{name}</td>
      <td className="px-2 py-2 tabular-nums">{rollup.statusCounts.pending}</td>
      <td className="px-2 py-2 tabular-nums">{rollup.statusCounts["in-progress"]}</td>
      <td
        className={`px-2 py-2 tabular-nums ${
          rollup.awaitingSignOff > 0 ? "font-semibold text-state-warning" : ""
        }`}
      >
        {rollup.statusCounts.witnessed}
      </td>
      <td className="px-2 py-2 tabular-nums text-text-muted">{rollup.statusCounts["signed-off"]}</td>
      <td className="px-2 py-2 tabular-nums">{rollup.openPoints}</td>
      <td className="px-2 py-2 tabular-nums">
        {rollup.oldestActiveAgeDays === null ? "—" : `${rollup.oldestActiveAgeDays}d`}
      </td>
      {/* Inline action — only when there's something awaiting sign-off. Points
          at the row's existing per-job ITP surface (no new route). */}
      <td className="px-2 py-2 text-right">
        {rollup.awaitingSignOff > 0 ? (
          <Link
            href={href}
            className="font-medium text-state-warning underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            Review
          </Link>
        ) : null}
      </td>
    </tr>
  );
}
