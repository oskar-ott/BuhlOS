"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Draft-timesheet export controls for a LOCKED payroll batch (#249), shown
 * under each batch on /hours/period when xero_payroll_export is on.
 *
 * Preview (no write) → explicit confirm → Export (POST draft timesheets +
 * readback reconcile) → Retry failed / Reconcile accepted-but-unverified. The
 * batch-CSV download is always available (it never writes to Xero) so it works
 * with the write flag off and while Xero is disconnected. DRAFT timesheets
 * only — no pay run, STP, tax, super or payslips (payroll-boundary ADR #609).
 */

type Verdict = "send" | "skip" | "blocked" | "requires_correction";
type Line = { EarningsRateID: string; NumberOfUnits: number[] };
type PreviewWorker = {
  workerId: string;
  workerName: string;
  employeeId: string | null;
  employeeName: string | null;
  calendarName: string | null;
  // The builder emits {start, end} (proving-run nit: the old {periodStart,
  // periodEnd} read rendered "undefined → undefined").
  period: { start: string; end: string } | null;
  totalUnits: number;
  dayCount: number;
  aligned: boolean;
  blocker: { code: string; message: string } | null;
  verdict: Verdict;
  priorTimesheetId: string | null;
  timesheet: { EmployeeID: string; StartDate: string; EndDate: string; Status: string; TimesheetLines: Line[] };
  contentHash: string;
};
type Preview = {
  org: { externalTenantId: string; status: string };
  workers: PreviewWorker[];
  counts: { total: number; toSend: number; toSkip: number; blocked: number; requiresCorrection: number };
};
type ResultWorker = {
  worker: string;
  outcome: string;
  xeroTimesheetId?: string | null;
  correlationId?: string | null;
  mismatches?: string[];
  blocker?: { message?: string };
  reason?: string;
  category?: string;
};
type RunResult = { batch: { id: string; status: string }; workers: ResultWorker[] };
type StateWorker = {
  workerId: string;
  workerName: string;
  employeeId: string | null;
  xeroTimesheetId: string | null;
  correlationId: string | null;
  lastOutcome: string | null;
  errorDetail?: string | null;
  status: string | null;
};
type ExportState = { workers: StateWorker[]; attemptCount: number; eventCount: number };

const BTN = "rounded-card border border-border px-3 py-1.5 text-sm font-medium text-text hover:border-brand-navy disabled:opacity-50";
const BTN_PRIMARY = "rounded-card bg-brand-navy px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50";

// Per-worker outcome/verdict/status → a tone for the badge. Verified/accepted =
// good; drift/retry = warning; rejected/blocked/correction = danger.
function tone(s: string | null | undefined): "success" | "warning" | "danger" | "muted" {
  switch (s) {
    case "verified":
    case "verified_against_xero":
    case "accepted":
    case "accepted_by_xero":
    case "send":
      return "success";
    case "drifted":
    case "retry_required":
      return "warning";
    case "rejected":
    case "blocked":
    case "requires_correction":
      return "danger";
    default:
      return "muted";
  }
}
const TONE_CLASS: Record<string, string> = {
  success: "border-state-success text-state-success",
  warning: "border-state-warning text-state-warning",
  danger: "border-state-danger text-state-danger",
  muted: "border-border text-text-muted",
};
function Badge({ label }: { label: string | null | undefined }) {
  const t = tone(label);
  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${TONE_CLASS[t]}`}>
      {label ?? "—"}
    </span>
  );
}

function lineUnits(l: Line): number {
  return Math.round((l.NumberOfUnits || []).reduce((s, u) => s + Number(u || 0), 0) * 100) / 100;
}

export function PayrollBatchExportSection({
  batchId,
  batchStatus,
  exportEnabled,
}: {
  batchId: string;
  batchStatus: string;
  exportEnabled: boolean;
}) {
  const [state, setState] = useState<ExportState | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmExport, setConfirmExport] = useState(false);
  const [showPayload, setShowPayload] = useState<string | null>(null);

  const refreshState = useCallback(async () => {
    if (!exportEnabled) return;
    try {
      const res = await fetch(`/api/xero/payroll-export?batchId=${batchId}`, { cache: "no-store" });
      if (res.ok) setState((await res.json()) as ExportState);
    } catch {
      /* leave state as-is; the action buttons still work */
    }
  }, [batchId, exportEnabled]);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  async function act(action: "preview" | "export" | "retry" | "reconcile") {
    setBusy(action);
    setError(null);
    if (action !== "preview") setResult(null);
    try {
      const res = await fetch("/api/xero/payroll-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, batchId }),
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) {
        setError(
          (data && typeof data.error === "string" && data.error) ||
            `The ${action} failed (${res.status}).`,
        );
        return;
      }
      if (action === "preview") {
        setPreview(data as unknown as Preview);
        setResult(null);
      } else {
        setResult(data as unknown as RunResult);
        setPreview(null);
        setConfirmExport(false);
        await refreshState();
      }
    } catch {
      setError("Network error — nothing was sent to Xero.");
    } finally {
      setBusy(null);
    }
  }

  const canReconcile = ["exporting", "partially_exported", "exported"].includes(batchStatus);
  const canRetry = ["exporting", "partially_exported"].includes(batchStatus);

  return (
    <div className="mt-3 rounded-card border border-dashed border-border px-3 py-3" data-testid="payroll-export-section">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-text">Xero export</span>
        <a
          className={BTN}
          href={`/api/xero/payroll-export?batchId=${batchId}&format=csv`}
          data-testid="payroll-export-csv"
        >
          Download batch CSV
        </a>
        {exportEnabled ? (
          <>
            <button className={BTN} disabled={busy !== null} onClick={() => void act("preview")} data-testid="payroll-export-preview">
              {busy === "preview" ? "Previewing…" : "Preview export"}
            </button>
            <button
              className={BTN_PRIMARY}
              // partially_exported must go through Retry failed — the server
              // refuses a plain export ("no mutation permitted", proving-run nit).
              disabled={busy !== null || (batchStatus !== "locked" && batchStatus !== "exporting")}
              onClick={() => setConfirmExport(true)}
              data-testid="payroll-export-run"
            >
              Export to Xero
            </button>
            {canRetry ? (
              <button className={BTN} disabled={busy !== null} onClick={() => void act("retry")} data-testid="payroll-export-retry">
                {busy === "retry" ? "Retrying…" : "Retry failed"}
              </button>
            ) : null}
            {canReconcile ? (
              <button className={BTN} disabled={busy !== null} onClick={() => void act("reconcile")} data-testid="payroll-export-reconcile">
                {busy === "reconcile" ? "Reconciling…" : "Reconcile"}
              </button>
            ) : null}
            <button className={BTN} disabled={busy !== null} onClick={() => void refreshState()}>
              Refresh results
            </button>
          </>
        ) : (
          <span className="text-xs text-text-muted">Draft-timesheet export is off — CSV download only.</span>
        )}
      </div>

      {error ? (
        <p className="mt-2 rounded-card border border-state-danger px-3 py-2 text-sm text-state-danger" role="alert">
          {error}
        </p>
      ) : null}

      {confirmExport ? (
        <div className="mt-3 space-y-2 rounded-card border-2 border-brand-navy px-3 py-3" data-testid="payroll-export-confirm">
          <p className="text-sm font-medium text-text">Create draft timesheets in Xero?</p>
          <p className="text-sm text-text-muted">
            This creates <strong>draft</strong> timesheets in Xero from this locked batch and reads
            each back to verify it. It does <strong>not</strong> create or post a pay run, and
            generates no STP, tax, super or payslips. Already-accepted workers are skipped; changed
            hours are blocked into a correction, never overwritten.
          </p>
          <div className="flex gap-2">
            <button className={BTN} onClick={() => setConfirmExport(false)}>Cancel</button>
            <button className={BTN_PRIMARY} disabled={busy !== null} onClick={() => void act("export")} data-testid="payroll-export-confirm-btn">
              {busy === "export" ? "Exporting…" : "Yes, create draft timesheets"}
            </button>
          </div>
        </div>
      ) : null}

      {preview ? (
        <div className="mt-3" data-testid="payroll-export-preview-result">
          <p className="text-sm text-text-muted">
            Org {preview.org.externalTenantId.slice(0, 8)} · {preview.counts.toSend} to send ·{" "}
            {preview.counts.toSkip} unchanged · {preview.counts.blocked} blocked ·{" "}
            {preview.counts.requiresCorrection} need correction. Nothing has been sent.
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-text-muted">
                  <th className="py-1 pr-3">Worker</th>
                  <th className="py-1 pr-3">Xero employee</th>
                  <th className="py-1 pr-3">Calendar</th>
                  <th className="py-1 pr-3">Period</th>
                  <th className="py-1 pr-3 text-right">Units</th>
                  <th className="py-1 pr-3">Lines</th>
                  <th className="py-1 pr-3">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {preview.workers.map((w) => (
                  <tr key={w.workerId} className="border-t border-border align-top">
                    <td className="py-1 pr-3">{w.workerName}</td>
                    <td className="py-1 pr-3">
                      {w.employeeName ?? <span className="text-state-danger">unmapped</span>}
                    </td>
                    <td className="py-1 pr-3">{w.calendarName ?? "—"}</td>
                    <td className="py-1 pr-3">{w.period ? `${w.period.start} → ${w.period.end}` : "—"}</td>
                    <td className="py-1 pr-3 text-right">{w.totalUnits}</td>
                    <td className="py-1 pr-3">
                      {w.aligned
                        ? w.timesheet.TimesheetLines.map((l, i) => (
                            <div key={i}>
                              {l.EarningsRateID.slice(0, 8)}: {lineUnits(l)}h
                            </div>
                          ))
                        : "—"}
                    </td>
                    <td className="py-1 pr-3">
                      <Badge label={w.verdict} />
                      {w.blocker ? <p className="mt-1 max-w-xs text-state-danger">{w.blocker.message}</p> : null}
                      {w.aligned ? (
                        <button
                          className="mt-1 block text-xs text-brand-navy underline"
                          onClick={() => setShowPayload(showPayload === w.workerId ? null : w.workerId)}
                        >
                          {showPayload === w.workerId ? "Hide payload" : "View payload"}
                        </button>
                      ) : null}
                      {showPayload === w.workerId ? (
                        <pre className="mt-1 max-w-xs overflow-x-auto rounded-card border border-border bg-surface-subtle p-2 text-[10px] text-text-muted">
                          {JSON.stringify(w.timesheet, null, 2)}
                        </pre>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="mt-3" data-testid="payroll-export-run-result">
          <p className="text-sm font-medium text-text">Result · batch {result.batch.status}</p>
          <ul className="mt-1 space-y-1 text-xs">
            {result.workers.map((w, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 border-t border-border py-1">
                <span className="font-medium text-text">{w.worker}</span>
                <Badge label={w.outcome} />
                {w.xeroTimesheetId ? <span className="text-text-muted">TS {w.xeroTimesheetId.slice(0, 8)}</span> : null}
                {w.correlationId ? <span className="text-text-muted">corr {w.correlationId.slice(0, 8)}</span> : null}
                {w.mismatches?.length ? <span className="text-state-warning">drift: {w.mismatches.join(", ")}</span> : null}
                {w.blocker?.message ? <span className="text-state-danger">{w.blocker.message}</span> : null}
                {w.reason ? <span className="text-text-muted">{w.reason}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!preview && !result && state && state.workers.length ? (
        <div className="mt-3" data-testid="payroll-export-state">
          <p className="text-sm font-medium text-text">Per-worker export status</p>
          <ul className="mt-1 space-y-1 text-xs">
            {state.workers.map((w) => (
              <li key={w.workerId} className="flex flex-wrap items-center gap-2 border-t border-border py-1">
                <span className="font-medium text-text">{w.workerName}</span>
                <Badge label={w.status ?? w.lastOutcome} />
                {w.xeroTimesheetId ? <span className="text-text-muted">TS {w.xeroTimesheetId.slice(0, 8)}</span> : null}
                {w.correlationId ? <span className="text-text-muted">corr {w.correlationId.slice(0, 8)}</span> : null}
                {/* Xero's actual refusal — a bare "rejected" chip left the
                    operator with nothing to act on (live find, 2026-07-25). */}
                {w.errorDetail && tone(w.status ?? w.lastOutcome) !== "success" ? (
                  <span className="text-state-danger">{w.errorDetail}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
