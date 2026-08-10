"use client";

import { Card, CardDescription, CardTitle } from "@/components/ui/Card";

/**
 * Pay-period payroll DOWNLOADS (#131 / #895) — read-only CSV previews.
 *
 * Both links are dry-run GETs: they never mark hours as exported. Recording a
 * payroll run is now the payroll-batch flow (the Payroll batch panel on this
 * page): Create batch → Validate → Lock → Export to Xero / Download batch CSV.
 * The legacy "Finalise + record export" POST is retired — a payroll MUTATION
 * must not hang off this endpoint (payroll-boundary ADR #609, amended for
 * export convergence: the locked batch is the single export source).
 */

interface Props {
  fromDate: string;
  toDate: string;
  /** Approved hours not yet in a locked batch — shown as context. */
  unexportedApprovedHours: number;
  eligibleWorkerCount: number;
  unmappedEligibleWorkerCount: number;
  /** The period still has undecided days — a warning, not a block. */
  notClosed: boolean;
}

export function PeriodPayrollExport({ fromDate, toDate, unexportedApprovedHours, notClosed }: Props) {
  const dryRunBase = `/api/time-entries-export?status=approved&fromDate=${fromDate}&toDate=${toDate}`;

  return (
    <Card>
      <CardTitle>Download for payroll</CardTitle>
      <CardDescription className="mt-1">
        <strong>Read-only CSV previews — they never mark hours as exported.</strong> To record a
        payroll run, use the Payroll batch panel on this page: create a batch, validate, lock it,
        then Export to Xero or download the batch CSV. The locked batch is the single source of a
        payroll run.
      </CardDescription>

      {notClosed ? (
        <p
          className="mt-2 rounded-card border border-state-warning px-3 py-2 text-xs text-state-warning"
          role="status"
        >
          This period isn&rsquo;t closed — totals will change once the undecided days are decided on
          the weekly board. Preview freely; batch once it&rsquo;s final.
        </p>
      ) : null}

      {unexportedApprovedHours > 0 ? (
        <p className="mt-2 text-xs text-text-muted">
          {unexportedApprovedHours} approved hour(s) in this period aren&rsquo;t in a locked batch yet.
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <a
          href={`${dryRunBase}&shape=review&dryRun=1`}
          className="rounded-card border border-border px-3 py-2 text-sm font-medium text-text hover:border-brand-navy"
          data-testid="period-download-review"
        >
          Download review CSV
        </a>
        <a
          href={`${dryRunBase}&shape=xero&dryRun=1`}
          className="rounded-card border border-border px-3 py-2 text-sm font-medium text-text hover:border-brand-navy"
          data-testid="period-download-xero"
        >
          Download Xero-ready CSV
        </a>
        {/* Owner pull 2026-08-10: the printable sheet — same rows as the CSVs,
            a container you can sign, file or send to the accountant. */}
        <a
          href={`${dryRunBase}&format=pdf&dryRun=1`}
          className="rounded-card border border-border px-3 py-2 text-sm font-medium text-text hover:border-brand-navy"
          data-testid="period-download-pdf"
        >
          Download PDF
        </a>
      </div>
      <p className="mt-2 text-xs text-text-muted">
        Every download is a dry run — none of them mark hours as exported. The PDF is the printable
        sheet (summary by worker + day breakdown); the CSVs are for spreadsheets and Xero.
      </p>
    </Card>
  );
}
