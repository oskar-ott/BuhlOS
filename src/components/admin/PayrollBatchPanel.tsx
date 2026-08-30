"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { PayrollBatchExportSection } from "./PayrollBatchExportSection";

/**
 * PayrollBatchPanel (#893/#894) — the payroll review surface on /hours/period.
 *
 * One glance answers "can this period be paid?": the validation engine's
 * errors (blockers) and warnings, per-worker totals, then Create batch →
 * Lock. A locked batch is immutable — the panel says so and offers only the
 * sanctioned paths (unlock, correction batch). Nothing here writes to Xero;
 * the CSV export beside this panel keeps working unchanged.
 */

type Finding = { code: string; message: string };
type Validation = {
  ready: boolean;
  errors: Finding[];
  warnings: Finding[];
  summary: { approvedRowCount: number; workerCount: number; totalHours: number; ordinaryHours: number; overtimeHours: number };
};
type Item = {
  worker_name: string;
  employee_name: string | null;
  earnings_rate_name: string | null;
  work_type: string;
  entry_date: string;
  job_name: string | null;
  hours: string | number;
};
type Batch = {
  id: string;
  status: string;
  period_start: string;
  period_end: string;
  item_count: number;
  total_hours: string | number;
  source_hash: string;
  revision: number;
  supersedes_batch_id: string | null;
  locked_by_name: string | null;
  locked_at: string | null;
  created_by_name: string | null;
  created_at: string;
  validation: Validation | null;
};
type BatchEvent = { event: string; actor_name: string | null; detail: Record<string, unknown> | null; created_at: string };

const BTN = "rounded-card border border-border px-3 py-1.5 text-sm font-medium text-text hover:border-brand-navy disabled:opacity-50";
const BTN_PRIMARY = "rounded-card bg-brand-navy px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50";
const BTN_DANGER = "rounded-card border border-state-danger px-3 py-1.5 text-sm font-medium text-state-danger hover:bg-state-danger/5 disabled:opacity-50";

const STATUS_COPY: Record<string, string> = {
  blocked: "Blocked — fix the named problems, then recreate",
  ready: "Ready to lock",
  locked: "Locked — immutable, ready for Xero (#249)",
  exported: "Exported",
  partially_exported: "Partially exported",
  reconciled: "Reconciled",
  correction_required: "Correction required",
};

function n(v: string | number): number {
  return Math.round(Number(v) * 100) / 100;
}

export function PayrollBatchPanel({
  fromDate,
  toDate,
  exportEnabled = false,
}: {
  fromDate: string;
  toDate: string;
  /** #249: xero_payroll_export — gates the draft-timesheet Export/Retry/Reconcile controls. */
  exportEnabled?: boolean;
}) {
  const [preview, setPreview] = useState<{ validation: Validation; items: Item[] } | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [detail, setDetail] = useState<{ batch: Batch; items: Item[]; events: BatchEvent[] } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "not_connected" | "error">("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmLock, setConfirmLock] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [pRes, bRes] = await Promise.all([
        fetch("/api/xero/payroll-batches", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "preview", periodStart: fromDate, periodEnd: toDate }),
        }),
        fetch(`/api/xero/payroll-batches?periodStart=${fromDate}&periodEnd=${toDate}`, { cache: "no-store" }),
      ]);
      if (pRes.status === 409 || bRes.status === 409) {
        setState("not_connected");
        return;
      }
      if (!pRes.ok || !bRes.ok) throw new Error("load failed");
      setPreview((await pRes.json()) as { validation: Validation; items: Item[] });
      setBatches(((await bRes.json()) as { batches: Batch[] }).batches);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [fromDate, toDate]);

  useEffect(() => {
    setDetail(null);
    void load();
  }, [load]);

  async function post(body: Record<string, unknown>, okMsg: string, busyKey: string) {
    setBusy(busyKey);
    setBanner(null);
    setError(null);
    try {
      const res = await fetch("/api/xero/payroll-batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok) {
        const code = data && typeof data.code === "string" ? data.code : null;
        setError(
          code === "source_drift"
            ? "The rows going into this batch changed after it was created (hours edited, or a worker's Xero link changed) — it's now blocked. Recreate it to pick up the current data."
            : code === "validation_failed"
              ? "Validation failed on re-check — the batch is now blocked with the reasons listed."
              : (data && typeof data.error === "string" && data.error) || "The action failed."
        );
        await load();
        return;
      }
      setBanner(okMsg);
      setConfirmLock(null);
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function openDetail(id: string) {
    const res = await fetch(`/api/xero/payroll-batches?id=${id}`, { cache: "no-store" });
    if (res.ok) setDetail((await res.json()) as { batch: Batch; items: Item[]; events: BatchEvent[] });
  }

  if (state === "loading") {
    return (
      <Card>
        <CardTitle>Finalise pay run</CardTitle>
        <CardDescription className="mt-1">Checking this period against every payroll rule…</CardDescription>
      </Card>
    );
  }
  if (state === "not_connected") {
    return (
      <Card>
        <CardTitle>Finalise pay run</CardTitle>
        <CardDescription className="mt-1">
          Xero isn&rsquo;t connected (or no organisation is selected). Connect on the{" "}
          <Link
            href={"/settings/integrations/xero" as Route}
            className="underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            Xero settings page
          </Link>{" "}
          to start batching payroll — the CSV export below keeps working either way.
        </CardDescription>
      </Card>
    );
  }
  if (state === "error" || !preview) {
    return (
      <Card>
        <CardTitle>Finalise pay run</CardTitle>
        <CardDescription className="mt-1">
          <span role="alert">Couldn&rsquo;t check this period. Reload to retry.</span>
        </CardDescription>
      </Card>
    );
  }

  const v = preview.validation;
  const periodBatches = batches;

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <CardTitle>Finalise pay run</CardTitle>
          <CardDescription className="mt-1">
            Commit an immutable payroll run for this period. {fromDate} → {toDate} ·{" "}
            {v.summary.workerCount} worker{v.summary.workerCount === 1 ? "" : "s"} ·{" "}
            {v.summary.totalHours}h ({v.summary.ordinaryHours} ordinary + {v.summary.overtimeHours}{" "}
            overtime). A batch snapshots the approved hours and mappings; once locked it is
            immutable — the safe source for the Xero draft-timesheet export (#249). Export happens
            per locked batch below, only after you explicitly confirm; it creates drafts, never a
            pay run in Xero.
          </CardDescription>
        </div>
        <span
          className={`shrink-0 rounded-full border px-3 py-1 text-sm font-medium ${
            v.ready ? "border-state-success text-state-success" : "border-state-danger text-state-danger"
          }`}
          data-testid="payroll-validation-state"
        >
          {v.ready ? "PASSES VALIDATION" : `${v.errors.length} BLOCKER${v.errors.length === 1 ? "" : "S"}`}
        </span>
      </div>

      {banner ? (
        <div className="mt-3 rounded-card border border-state-success px-3 py-2 text-sm text-state-success" role="status">
          {banner}
        </div>
      ) : null}
      {error ? (
        <div className="mt-3 rounded-card border border-state-danger px-3 py-2 text-sm text-state-danger" role="alert">
          {error}
        </div>
      ) : null}

      {v.errors.length ? (
        <ul className="mt-3 space-y-1" data-testid="payroll-validation-errors">
          {v.errors.map((e) => (
            <li key={e.code} className="rounded-card border border-state-danger px-3 py-2 text-sm text-state-danger">
              {e.message}
            </li>
          ))}
        </ul>
      ) : null}
      {v.warnings.length ? (
        <ul className="mt-2 space-y-1" data-testid="payroll-validation-warnings">
          {v.warnings.map((w) => (
            <li key={w.code} className="rounded-card border border-state-warning px-3 py-2 text-sm text-state-warning">
              {w.message}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className={BTN_PRIMARY}
          disabled={busy !== null || !v.ready}
          onClick={() => void post({ action: "create", periodStart: fromDate, periodEnd: toDate }, "Payroll batch created.", "create")}
          data-testid="payroll-batch-create"
        >
          {busy === "create" ? "Creating…" : "Create payroll batch"}
        </button>
        {!v.ready ? (
          <span className="self-center text-xs text-text-muted">Fix the blockers above, then create.</span>
        ) : null}
      </div>

      {periodBatches.length ? (
        <div className="mt-4 border-t border-border pt-3">
          <p className="text-sm font-medium text-text">Batches for this period</p>
          <ul className="mt-2 space-y-2" data-testid="payroll-batch-list">
            {periodBatches.map((b) => (
              <li key={b.id} className="rounded-card border border-border px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-text">
                      {STATUS_COPY[b.status] ?? b.status}
                      {b.supersedes_batch_id ? (
                        <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-xs text-text-muted">
                          correction · rev {b.revision}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-text-muted">
                      {b.item_count} items · {n(b.total_hours)}h · created{" "}
                      {new Date(b.created_at).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })} by {b.created_by_name ?? "admin"}
                      {b.locked_at ? ` · locked ${new Date(b.locked_at).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })} by ${b.locked_by_name ?? "admin"}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button className={BTN} onClick={() => void openDetail(b.id)}>
                      {detail?.batch.id === b.id ? "Refresh detail" : "View detail"}
                    </button>
                    {b.status === "ready" ? (
                      confirmLock === b.id ? (
                        <>
                          <button
                            className={BTN_PRIMARY}
                            disabled={busy !== null}
                            onClick={() => void post({ action: "lock", id: b.id }, "Batch locked — it is now immutable.", "lock")}
                            data-testid="payroll-batch-lock-confirm"
                          >
                            {busy === "lock" ? "Locking…" : "Yes, lock it"}
                          </button>
                          <button className={BTN} onClick={() => setConfirmLock(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button className={BTN_PRIMARY} onClick={() => setConfirmLock(b.id)} data-testid="payroll-batch-lock">
                          Lock payroll
                        </button>
                      )
                    ) : null}
                    {b.status === "ready" || b.status === "blocked" ? (
                      <button
                        className={BTN_DANGER}
                        disabled={busy !== null}
                        onClick={() => void post({ action: "delete", id: b.id }, "Batch deleted.", "delete")}
                      >
                        Delete
                      </button>
                    ) : null}
                    {b.status === "locked" ? (
                      <button
                        className={BTN}
                        disabled={busy !== null}
                        onClick={() => void post({ action: "unlock", id: b.id }, "Batch unlocked — it can be revalidated or deleted.", "unlock")}
                        data-testid="payroll-batch-unlock"
                      >
                        Unlock
                      </button>
                    ) : null}
                    {["exported", "partially_exported", "reconciled", "correction_required"].includes(b.status) ? (
                      <button
                        className={BTN}
                        disabled={busy !== null}
                        onClick={() =>
                          void post(
                            { action: "create", periodStart: fromDate, periodEnd: toDate, supersedesBatchId: b.id },
                            "Correction batch created.",
                            "correction"
                          )
                        }
                      >
                        Create correction batch
                      </button>
                    ) : null}
                  </div>
                </div>
                {["locked", "exporting", "partially_exported", "exported", "reconciled", "correction_required"].includes(b.status) ? (
                  <PayrollBatchExportSection batchId={b.id} batchStatus={b.status} exportEnabled={exportEnabled} />
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {detail ? (
        <div className="mt-4 border-t border-border pt-3" data-testid="payroll-batch-detail">
          <p className="text-sm font-medium text-text">
            Batch {detail.batch.id.slice(0, 8)} · {STATUS_COPY[detail.batch.status] ?? detail.batch.status}
          </p>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-text-muted">
                  <th className="py-1 pr-3">Date</th>
                  <th className="py-1 pr-3">Worker</th>
                  <th className="py-1 pr-3">Xero employee</th>
                  <th className="py-1 pr-3">Type</th>
                  <th className="py-1 pr-3">Earnings rate</th>
                  <th className="py-1 pr-3">Job</th>
                  <th className="py-1 pr-3 text-right">Hours</th>
                </tr>
              </thead>
              <tbody>
                {detail.items.map((i, idx) => (
                  <tr key={idx} className="border-t border-border">
                    <td className="py-1 pr-3">{String(i.entry_date).slice(0, 10)}</td>
                    <td className="py-1 pr-3">{i.worker_name}</td>
                    <td className="py-1 pr-3">{i.employee_name ?? <span className="text-state-danger">unmapped</span>}</td>
                    <td className="py-1 pr-3">{i.work_type}</td>
                    <td className="py-1 pr-3">{i.earnings_rate_name ?? <span className="text-state-danger">unmapped</span>}</td>
                    <td className="py-1 pr-3">{i.job_name ?? "Internal"}</td>
                    <td className="py-1 pr-3 text-right">{n(i.hours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-sm font-medium text-text">History</p>
          <ul className="mt-1 space-y-0.5 text-xs text-text-muted" data-testid="payroll-batch-events">
            {detail.events.map((e, idx) => (
              <li key={idx}>
                {new Date(e.created_at).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })} — {e.event}
                {e.actor_name ? ` by ${e.actor_name}` : ""}
              </li>
            ))}
          </ul>
          <p className="mt-2 break-all text-xs text-text-muted">source hash {detail.batch.source_hash}</p>
        </div>
      ) : null}
    </Card>
  );
}
