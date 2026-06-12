"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { payrollPreview, payrollRuns } from "@/domains/timesheets/client";
import {
  payrollCommitUrl,
  summariseAlreadyExported,
  type AlreadyExportedSummary,
} from "@/domains/timesheets/payroll-export";
import type {
  PayrollExportPreviewResponse,
  PayrollRun,
} from "@/domains/timesheets/types";

/**
 * Committed payroll export from the weekly board (#126) — the last
 * legacy-only hours capability. Flow: fresh dry-run preview → confirm sheet
 * that restates the week, counts, NOT-payroll-ready workers and any
 * already-exported rows (blocking by default — explicit acknowledgement to
 * re-export) → programmatic navigation to the committed CSV.
 *
 * Why navigation, not fetch: the committed run is a mutating GET that
 * streams a Content-Disposition download; fetch() would orphan the file and
 * the X-Export-Id header is invisible to a navigation — so success is
 * confirmed by re-reading /api/payroll-runs and finding the new run.
 * Rendered ONLY behind onClick handlers — never a <Link>/<a> Next could
 * prefetch.
 *
 * The CSV contains rates and costs: its contents are never fetched, cached
 * or logged client-side — the browser download is the only consumer.
 */

interface Props {
  weekStart: string;
  weekEnd: string;
  weekLabel: string;
  /** Workers the closeout banded as not payroll-ready (named in confirm). */
  notReadyWorkers: ReadonlyArray<string>;
  initialRuns: ReadonlyArray<PayrollRun>;
  runsError: string | null;
}

type Stage =
  | { kind: "idle" }
  | { kind: "previewing" }
  | { kind: "preview-failed"; message: string }
  | {
      kind: "confirm";
      preview: PayrollExportPreviewResponse;
      already: AlreadyExportedSummary;
      acknowledged: boolean;
    }
  | { kind: "committing" }
  | { kind: "committed"; runConfirmed: boolean; exportId: string | null };

export function WeeklyPayrollExportPanel({
  weekStart,
  weekEnd,
  weekLabel,
  notReadyWorkers,
  initialRuns,
  runsError,
}: Props) {
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [runs, setRuns] = useState<ReadonlyArray<PayrollRun>>(initialRuns);

  async function loadPreview() {
    setStage({ kind: "previewing" });
    const result = await payrollPreview({ fromDate: weekStart, toDate: weekEnd });
    if (!result.ok) {
      setStage({ kind: "preview-failed", message: result.error.message });
      return;
    }
    setStage({
      kind: "confirm",
      preview: result.data,
      already: summariseAlreadyExported(result.data.rows ?? []),
      acknowledged: false,
    });
  }

  function commit() {
    if (stage.kind !== "confirm") return;
    setStage({ kind: "committing" });
    // Mutating GET by design (the endpoint's contract): the browser handles
    // the CSV download; the page stays. Success is confirmed via the runs
    // log below, since response headers are invisible to a navigation.
    window.location.assign(payrollCommitUrl({ fromDate: weekStart, toDate: weekEnd }));
    window.setTimeout(() => {
      void payrollRuns(10).then((result) => {
        if (result.ok) {
          const newest = result.data.runs[0] ?? null;
          const confirmed =
            newest != null &&
            newest.range.fromDate === weekStart &&
            newest.range.toDate === weekEnd &&
            !initialRuns.some((r) => r.exportId === newest.exportId);
          setRuns(result.data.runs);
          setStage({
            kind: "committed",
            runConfirmed: confirmed,
            exportId: confirmed ? newest.exportId : null,
          });
        } else {
          setStage({ kind: "committed", runConfirmed: false, exportId: null });
        }
      });
    }, 2500);
  }

  const summary = stage.kind === "confirm" ? stage.preview.summary : null;
  const hasRows = (summary?.rowCount ?? 0) > 0;

  return (
    <Card role="region" aria-label="Payroll export">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Payroll export</CardTitle>
        <Pill tone="neutral">Approved hours only</Pill>
      </div>
      <CardDescription className="mt-1">
        The committed run for {weekLabel}: downloads the CSV, stamps every included entry with a
        run id, and logs the run with a content hash. Preview first — nothing is stamped until
        you commit.
      </CardDescription>

      <div className="mt-3 space-y-3 text-sm">
        {stage.kind === "idle" || stage.kind === "previewing" || stage.kind === "preview-failed" ? (
          <>
            {stage.kind === "preview-failed" ? (
              <p className="rounded-card border border-state-danger px-3 py-2 text-state-danger" role="alert">
                Preview failed: {stage.message}. Nothing was exported — try again.
              </p>
            ) : null}
            <Button
              size="sm"
              onClick={() => void loadPreview()}
              disabled={stage.kind === "previewing"}
              data-testid="payroll-export-preview"
            >
              {stage.kind === "previewing" ? "Checking the week…" : "Preview this week's run"}
            </Button>
          </>
        ) : null}

        {stage.kind === "confirm" && summary ? (
          <div className="space-y-3" data-testid="payroll-export-confirm">
            <div className="flex flex-wrap gap-2">
              <Pill tone={hasRows ? "success" : "neutral"}>{summary.rowCount} rows</Pill>
              <Pill tone="neutral">
                {summary.workerCount} {summary.workerCount === 1 ? "worker" : "workers"}
              </Pill>
              <Pill tone="neutral">
                {weekStart} → {weekEnd}
              </Pill>
            </div>

            {!hasRows ? (
              <p className="text-text-muted">
                No approved hours in this week — nothing to export. Approve the submitted days
                first.
              </p>
            ) : null}

            {notReadyWorkers.length > 0 ? (
              <p className="rounded-card border border-state-warning px-3 py-2 text-state-warning" role="status">
                {notReadyWorkers.length === 1
                  ? `${notReadyWorkers[0]} isn't payroll-ready`
                  : `${notReadyWorkers.length} workers aren't payroll-ready (${notReadyWorkers.join(", ")})`}{" "}
                — days approved after this run will need a follow-up export.
              </p>
            ) : null}

            {stage.already.rowCount > 0 ? (
              <div className="space-y-2 rounded-card border border-state-danger px-3 py-2" role="alert">
                <p className="text-state-danger">
                  {stage.already.rowCount} row{stage.already.rowCount === 1 ? " was" : "s were"}{" "}
                  already exported (run{stage.already.exportIds.length === 1 ? "" : "s"}{" "}
                  {stage.already.exportIds.join(", ")}). Committing again re-stamps them with the
                  new run id — your payroll system may see duplicates.
                </p>
                <label className="flex items-start gap-2 text-text">
                  <input
                    type="checkbox"
                    checked={stage.acknowledged}
                    onChange={(e) =>
                      setStage({ ...stage, acknowledged: e.target.checked })
                    }
                    data-testid="payroll-export-acknowledge"
                  />
                  <span>Export anyway — I understand these rows were already in a run.</span>
                </label>
              </div>
            ) : null}

            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setStage({ kind: "idle" })}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={commit}
                disabled={!hasRows || (stage.already.rowCount > 0 && !stage.acknowledged)}
                data-testid="payroll-export-commit"
              >
                Commit &amp; download CSV
              </Button>
            </div>
          </div>
        ) : null}

        {stage.kind === "committing" ? (
          <p className="text-text-muted" role="status">
            Running the export — the CSV download starts in your browser…
          </p>
        ) : null}

        {stage.kind === "committed" ? (
          <div className="space-y-2">
            {stage.runConfirmed ? (
              <p className="rounded-card border border-state-success px-3 py-2 text-state-success" role="status">
                Export committed — run {stage.exportId} is in the log below and the included days
                now carry an Exported marker.
              </p>
            ) : (
              <p className="rounded-card border border-state-warning px-3 py-2 text-state-warning" role="status">
                The export ran (check your downloads), but the run log entry couldn&rsquo;t be
                confirmed — reload to see the latest log. If the CSV didn&rsquo;t download,
                nothing may have been stamped; preview again to check.
              </p>
            )}
            <Button size="sm" variant="secondary" onClick={() => setStage({ kind: "idle" })}>
              Done
            </Button>
          </div>
        ) : null}
      </div>

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
