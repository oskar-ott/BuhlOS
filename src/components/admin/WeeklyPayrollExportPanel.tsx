"use client";

import Link from "next/link";
import type { Route } from "next";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import type { PayrollRun } from "@/domains/timesheets/types";

/**
 * Weekly payroll runs (#126 / #895) — READ-ONLY.
 *
 * The committed run from the weekly board is retired: handing hours to
 * accounts happens on the Pay period tab (email the sheet, or lock a batch and
 * create Xero draft timesheets — payroll-boundary ADR #609). This panel keeps
 * the historical run log for reference; it no longer previews, stamps entries
 * or writes a run — so there is no mutating GET the browser could prefetch,
 * bookmark or retry. The one sentence of copy links to the Pay period tab FOR
 * THIS WEEK (2026-09-26 audit: the old paragraph was dev-speak with no link).
 */

interface Props {
  weekStart: string;
  weekEnd: string;
  weekLabel: string;
  /** Workers the closeout banded as not payroll-ready (kept for the caller). */
  notReadyWorkers: ReadonlyArray<string>;
  initialRuns: ReadonlyArray<PayrollRun>;
  runsError: string | null;
}

export function WeeklyPayrollExportPanel({ weekStart, weekLabel, initialRuns, runsError }: Props) {
  const runs = initialRuns;

  return (
    <Card role="region" aria-label="Payroll runs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Payroll runs</CardTitle>
        <Pill tone="neutral">Read-only</Pill>
      </div>
      <CardDescription className="mt-1">
        Hand the approved hours for {weekLabel} to accounts from the{" "}
        <Link
          href={{ pathname: "/hours/period" as Route, query: { period: "week", anchor: weekStart } }}
          data-testid="weekly-runs-open-period"
          className="font-medium text-brand-navy underline underline-offset-2"
        >
          Pay period tab for this week
        </Link>
        .
      </CardDescription>

      <div className="mt-4">
        <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted">Past runs</h3>
        {runsError ? (
          <p className="mt-1 text-sm text-text-muted">Couldn&rsquo;t load the run log: {runsError}</p>
        ) : runs.length === 0 ? (
          <p className="mt-1 text-sm text-text-muted">No committed runs yet.</p>
        ) : (
          <ul className="mt-1 divide-y divide-border text-sm">
            {runs.map((run) => (
              <li key={run.exportId} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2">
                <span className="min-w-0">
                  <span className="font-medium text-text">{run.exportId}</span>
                  <span className="text-text-muted">
                    {" "}
                    · {run.range.fromDate} → {run.range.toDate}
                    {typeof run.rowCount === "number" ? ` · ${run.rowCount} rows` : ""}
                    {run.actorName ? ` · by ${run.actorName}` : ""}
                  </span>
                </span>
                <span className="text-xs text-text-muted">
                  {new Date(run.at).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}
                  {run.hash ? ` · ${run.hash.slice(0, 8)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
