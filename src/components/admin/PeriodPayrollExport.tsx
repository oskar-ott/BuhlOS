"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";

/**
 * Pay-period payroll export (#131) — the office's pre-Xero package.
 *
 * THREE actions, two safety classes:
 *   - Download review CSV / Download Xero-ready CSV — dry-run GETs (dryRun=1).
 *     Plain <a>: they never mutate, so a prefetch/bookmark/retry is harmless.
 *   - Finalise + record export — an explicit POST (not a casual GET link). A
 *     payroll MUTATION must not hang off something a browser can prefetch,
 *     bookmark or crawl. Confirm → POST → the server stamps ONLY eligible rows
 *     (approved AND not already in a run; never re-stamped), appends the run
 *     log, and streams back the run's CSV. We read X-Export-Id straight off the
 *     response (a navigation can't see headers — POST can).
 *
 * This is the BRIDGE, not a Xero connection: the CSV feeds manual entry/import
 * into Xero today and is the feedstock for the later Xero Payroll AU draft-
 * timesheet API (#249). No OAuth, no push, no pay runs (payroll-boundary ADR
 * #609). Earnings classes are ordinary + overtime only — nothing faked.
 */

interface Props {
  fromDate: string;
  toDate: string;
  /** Approved hours not yet in a committed run — what finalise will record. */
  unexportedApprovedHours: number;
  /** Workers with NOT-YET-EXPORTED hours — the ones a finalise actually touches. */
  eligibleWorkerCount: number;
  /**
   * Workers with not-yet-exported hours AND no Xero employee id. This is the
   * gate the server enforces (eligible rows only), so the button matches it —
   * an already-exported unmapped worker must not block a new-hours run.
   */
  unmappedEligibleWorkerCount: number;
  /** The period still has undecided days — a warning, not a block. */
  notClosed: boolean;
}

type Stage =
  | { kind: "idle" }
  | { kind: "confirm" }
  | { kind: "committing" }
  | { kind: "committed"; exportId: string | null; rowCount: string | null }
  | { kind: "failed"; message: string };

export function PeriodPayrollExport({
  fromDate,
  toDate,
  unexportedApprovedHours,
  eligibleWorkerCount,
  unmappedEligibleWorkerCount,
  notClosed,
}: Props) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });

  const dryRunBase = `/api/time-entries-export?status=approved&fromDate=${fromDate}&toDate=${toDate}`;

  const nothingNew = unexportedApprovedHours <= 0;
  const blockedByMapping = unmappedEligibleWorkerCount > 0;
  // A Xero-ready committed run blocks on unmapped workers and on nothing-new.
  const canFinalise = !nothingNew && !blockedByMapping;

  async function doFinalise() {
    setStage({ kind: "committing" });
    try {
      const res = await fetch("/api/time-entries-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromDate, toDate, shape: "xero", status: "approved" }),
      });
      if (!res.ok) {
        let message = `Finalise failed (${res.status}) — nothing was recorded.`;
        try {
          const j = (await res.json()) as { error?: string };
          if (j?.error) message = j.error;
        } catch {
          /* non-JSON error body — keep the generic message */
        }
        setStage({ kind: "failed", message });
        return;
      }
      const exportId = res.headers.get("X-Export-Id");
      const rowCount = res.headers.get("X-Row-Count");
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") ?? "";
      const filename =
        cd.match(/filename="([^"]+)"/)?.[1] ??
        `buhlos-xero-ready-hours-${fromDate}-to-${toDate}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStage({ kind: "committed", exportId, rowCount });
      // The server-rendered table (unexported totals) is now stale — refresh it.
      router.refresh();
    } catch (err) {
      setStage({
        kind: "failed",
        message: err instanceof Error ? err.message : "Network error — nothing was recorded.",
      });
    }
  }

  return (
    <Card>
      <CardTitle>Download for payroll</CardTitle>
      <CardDescription className="mt-1">
        <strong>Xero-ready CSV bridge — no direct Xero connection yet.</strong> Use it to
        review or manually enter/import payroll into Xero; a future Xero API sync will use
        the same approved-hour package. Preview downloads do not mark hours as exported —
        finalising records this payroll export in BuhlOS.
      </CardDescription>

      {notClosed || blockedByMapping ? (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-900">
          {notClosed ? (
            <li>
              This period isn&rsquo;t closed — totals will change once the undecided days are
              decided on the weekly board. Preview freely; finalise once it&rsquo;s final.
            </li>
          ) : null}
          {blockedByMapping ? (
            <li>
              {unmappedEligibleWorkerCount} worker(s) with new hours have no Xero employee id — a
              Xero-ready finalise is <strong>blocked</strong> until they&rsquo;re mapped (or use the
              Review CSV).
            </li>
          ) : null}
        </ul>
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
      </div>
      <p className="mt-2 text-xs text-text-muted">
        Both downloads are dry runs — they never mark hours as exported.
      </p>

      <div className="mt-4 border-t border-border pt-4">
        {stage.kind === "idle" || stage.kind === "failed" ? (
          <>
            {stage.kind === "failed" ? (
              <p
                className="mb-2 rounded-card border border-state-danger px-3 py-2 text-sm text-state-danger"
                role="alert"
              >
                {stage.message}
              </p>
            ) : null}
            {nothingNew ? (
              <p className="text-sm text-text-muted">
                All approved hours in this period are already in a committed run — nothing new to
                finalise.
              </p>
            ) : (
              <>
                <Button
                  size="sm"
                  onClick={() => setStage({ kind: "confirm" })}
                  disabled={!canFinalise}
                  data-testid="period-finalise"
                >
                  Finalise + record export
                </Button>
                {blockedByMapping ? (
                  <p className="mt-2 text-xs text-amber-900">
                    Map the {unmappedEligibleWorkerCount} worker(s) above before a Xero-ready run can
                    be recorded.
                  </p>
                ) : null}
              </>
            )}
          </>
        ) : null}

        {stage.kind === "confirm" ? (
          <div
            className="space-y-3 rounded-card border-2 border-brand-navy px-3 py-3"
            data-testid="period-finalise-confirm"
          >
            <p className="text-sm text-text">
              Record a Xero-ready payroll run for <strong>{fromDate} → {toDate}</strong>:{" "}
              <strong>{unexportedApprovedHours}</strong> approved hour(s) not yet in a run, across{" "}
              {eligibleWorkerCount} worker(s). The included days get an Exported marker and a run is
              logged.
            </p>
            <p className="text-sm text-text-muted">
              Only finalise once this exact CSV has been reviewed and is the file you intend to use
              for payroll. Rows already in a run are excluded — they keep their original run id.
            </p>
            {notClosed ? (
              <p
                className="rounded-card border border-state-warning px-3 py-2 text-sm text-state-warning"
                role="status"
              >
                This period isn&rsquo;t closed yet — days decided later will need a follow-up run.
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setStage({ kind: "idle" })}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void doFinalise()} data-testid="period-finalise-confirm-btn">
                Finalise &amp; download CSV
              </Button>
            </div>
          </div>
        ) : null}

        {stage.kind === "committing" ? (
          <p className="text-sm text-text-muted" role="status">
            Recording the run and preparing the CSV download…
          </p>
        ) : null}

        {stage.kind === "committed" ? (
          <div className="space-y-2">
            <p
              className="rounded-card border border-state-success px-3 py-2 text-sm text-state-success"
              role="status"
            >
              Export recorded{stage.exportId ? ` — run ${stage.exportId}` : ""}
              {stage.rowCount ? `, ${stage.rowCount} row(s)` : ""}. The CSV has downloaded and the
              included days now carry an Exported marker.
            </p>
            <Button size="sm" variant="secondary" onClick={() => setStage({ kind: "idle" })}>
              Done
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
