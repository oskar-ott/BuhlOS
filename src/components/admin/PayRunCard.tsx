"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";
import { chooseBatchForPeriod, nextBatchStep } from "@/domains/timesheets/xero-closeout";
import { PreviewLinksRow } from "./PreviewLinksRow";

/**
 * PayRunCard (owner redesign 2026-08-16, "BuhlOS Hours Replica") — the pay
 * period's ONE payroll-run card: a three-step stepper over the same immutable
 * batch engine as before. Create the batch (snapshot) → Lock it → Send to
 * Xero as draft timesheets. One-line copy per step; the machinery
 * (validation, correction batches, retry, per-worker outcomes, CSV) stays.
 *
 * Replaces the PayrollBatchPanel + PayrollBatchExportSection pair on
 * /hours/period (the deep batch-forensics view — event history, payload
 * inspection, reconcile — lives in git history if it's ever missed).
 *
 * Same honesty rules as the old panel:
 * - opening WRITES NOTHING (preview action persists nothing);
 * - a 409 means Xero isn't connected — said plainly, downloads unaffected;
 * - export controls ride the xero_payroll_export flag (`exportEnabled`);
 * - "sent" rows are the SERVER's per-worker outcomes, never a local guess.
 */

type Finding = { code: string; message: string; workers?: string[] };
type Validation = { ready: boolean; errors: Finding[]; warnings: Finding[] };
type Batch = {
  id: string;
  status: string;
  revision: number;
  item_count: number;
  total_hours: string | number;
  supersedes_batch_id: string | null;
  locked_by_name: string | null;
  locked_at: string | null;
};
type Item = {
  entry_date: string;
  worker_name: string;
  work_type: string;
  job_name: string | null;
  hours: string | number;
};
type ResultWorker = {
  worker: string;
  outcome: string;
  xeroTimesheetId?: string | null;
  blocker?: { message?: string };
};
type StateWorker = {
  workerName: string;
  status: string | null;
  lastOutcome: string | null;
  xeroTimesheetId: string | null;
  errorDetail?: string | null;
};
type SentRow = { name: string; outcome: string | null; tsId: string | null; detail: string | null };

function n2(v: string | number): number {
  return Math.round(Number(v) * 100) / 100;
}

function batchChip(batch: Batch): { tone: "info" | "navy" | "success" | "warning" | "danger" | "neutral"; label: string } {
  switch (batch.status) {
    case "ready":
      return { tone: "info", label: "Ready to lock" };
    case "locked":
      return { tone: "navy", label: "Locked" };
    case "exported":
      return { tone: "success", label: "Sent to Xero" };
    case "partially_exported":
      return { tone: "warning", label: "Partly sent" };
    case "exporting":
      return { tone: "warning", label: "Sending" };
    case "blocked":
      return { tone: "danger", label: "Blocked" };
    default:
      return { tone: "neutral", label: batch.status };
  }
}

function exportTone(s: string | null): "success" | "warning" | "danger" | "muted" {
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
const EXPORT_TONE_CLASS = {
  success: "border-state-success text-state-success",
  warning: "border-state-warning text-state-warning",
  danger: "border-state-danger text-state-danger",
  muted: "border-border text-text-muted",
} as const;

function ExportBadge({ label }: { label: string | null }) {
  return (
    <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", EXPORT_TONE_CLASS[exportTone(label)])}>
      {label ?? "—"}
    </span>
  );
}

function SentWorkerRows({ rows }: { rows: SentRow[] }) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-card border border-border">
      {rows.map((w, i) => (
        <li key={i} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 truncate font-medium text-text">{w.name}</span>
          {w.tsId ? <span className="font-mono text-[10px] text-text-muted">TS {w.tsId.slice(0, 8)}</span> : null}
          <ExportBadge label={w.outcome} />
          {w.detail ? <span className="w-full text-xs text-state-danger">{w.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function StepRow({
  n,
  state,
  title,
  sub,
  children,
  last,
}: {
  n: number;
  state: "done" | "current" | "todo";
  title: string;
  sub?: string;
  children?: React.ReactNode;
  last?: boolean;
}) {
  return (
    <li className="relative flex gap-3 pb-5 last:pb-0">
      {!last ? <span aria-hidden="true" className="absolute bottom-0 left-[13px] top-8 w-px bg-border" /> : null}
      <span
        className={cn(
          "z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-display text-[13px] font-bold",
          state === "done"
            ? "bg-brand-navy text-text-inverse"
            : state === "current"
              ? "bg-accent-yellow text-brand-navy"
              : "border border-border bg-surface text-text-muted",
        )}
      >
        {state === "done" ? <Check aria-hidden="true" className="h-4 w-4" /> : n}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className={cn("font-display text-sm font-semibold", state === "todo" ? "text-text-muted" : "text-text")}>
          {title}
        </p>
        {sub ? <p className="mt-0.5 text-xs text-text-muted">{sub}</p> : null}
        {children ? <div className="mt-2.5">{children}</div> : null}
      </div>
    </li>
  );
}

export function PayRunCard({
  fromDate,
  toDate,
  notClosed,
  exportEnabled,
}: {
  fromDate: string;
  toDate: string;
  /** Undecided days remain in the period — a nudge, never a block. */
  notClosed: boolean;
  /** #249 xero_payroll_export — gates the draft-timesheet send (CSV always works). */
  exportEnabled: boolean;
}) {
  const [validation, setValidation] = useState<Validation | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "not_connected" | "error">("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [confirmSend, setConfirmSend] = useState(false);
  const [sendResult, setSendResult] = useState<ResultWorker[] | null>(null);
  const [stateWorkers, setStateWorkers] = useState<StateWorker[] | null>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [showRows, setShowRows] = useState(false);

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
        setLoadState("not_connected");
        return;
      }
      if (!pRes.ok || !bRes.ok) throw new Error("load failed");
      const preview = (await pRes.json()) as { validation: Validation };
      const list = (await bRes.json()) as { batches: Batch[] };
      setValidation(preview.validation);
      setBatches(list.batches);
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }, [fromDate, toDate]);

  useEffect(() => {
    setLoadState("loading");
    setSendResult(null);
    setItems(null);
    setShowRows(false);
    setConfirmSend(false);
    setBanner(null);
    setError(null);
    void load();
  }, [load]);

  const batch = chooseBatchForPeriod(batches);
  const step = nextBatchStep(batch);
  const stepIndex = step === "done" ? 4 : step === "export" ? 3 : step === "lock" ? 2 : 1;

  // Already-exported periods: read back the per-worker outcomes so reopening
  // the page still shows who landed in Xero. Flag-gated like the send itself.
  useEffect(() => {
    let on = true;
    if (exportEnabled && batch && ["exported", "partially_exported", "exporting"].includes(batch.status)) {
      void fetch(`/api/xero/payroll-export?batchId=${batch.id}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((st: { workers?: StateWorker[] } | null) => {
          if (on) setStateWorkers(st?.workers ?? null);
        });
    } else {
      setStateWorkers(null);
    }
    return () => {
      on = false;
    };
    // batch identity, not the object reference
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportEnabled, batch?.id, batch?.status]);

  async function act(body: Record<string, unknown>, busyKey: string, okMsg: string | null) {
    setBusy(busyKey);
    setError(null);
    setBanner(null);
    try {
      const res = await fetch("/api/xero/payroll-batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
      if (!res.ok) {
        setError(
          data?.code === "source_drift"
            ? "The rows behind this batch changed after it was created — it's now blocked. Delete it and create a fresh one."
            : data?.code === "validation_failed"
              ? "Validation failed on re-check — the batch is blocked with the reasons listed."
              : data?.error || "That didn't work — try again.",
        );
        await load();
        return;
      }
      if (okMsg) setBanner(okMsg);
      await load();
    } finally {
      setBusy(null);
    }
  }
  const createBatch = () =>
    act({ action: "create", periodStart: fromDate, periodEnd: toDate }, "create", "Batch created — the approved hours are snapshotted.");
  const lockBatch = () => batch && act({ action: "lock", id: batch.id }, "lock", "Locked — the numbers are final.");
  const unlockBatch = () => batch && act({ action: "unlock", id: batch.id }, "unlock", null);
  const deleteBatch = () => batch && act({ action: "delete", id: batch.id }, "delete", "Batch deleted.");
  const correctionBatch = () =>
    batch &&
    act(
      { action: "create", periodStart: fromDate, periodEnd: toDate, supersedesBatchId: batch.id },
      "create",
      "Correction batch created.",
    );

  async function send() {
    if (!batch) return;
    setBusy("send");
    setError(null);
    setConfirmSend(false);
    try {
      const res = await fetch("/api/xero/payroll-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: batch.status === "locked" ? "export" : "retry", batchId: batch.id }),
      });
      const data = (await res.json().catch(() => null)) as { workers?: ResultWorker[]; error?: string } | null;
      if (!res.ok) {
        setError(data?.error || "Couldn't reach Xero — nothing was sent.");
        return;
      }
      setSendResult(data?.workers ?? []);
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function toggleRows() {
    if (showRows) {
      setShowRows(false);
      return;
    }
    if (!items && batch) {
      const res = await fetch(`/api/xero/payroll-batches?id=${batch.id}`, { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { items: Item[] };
        setItems(data.items);
      }
    }
    setShowRows(true);
  }

  if (loadState === "loading") {
    return (
      <Card>
        <CardTitle>Payroll run</CardTitle>
        <CardDescription className="mt-1">Checking this period…</CardDescription>
      </Card>
    );
  }
  if (loadState === "not_connected") {
    return (
      <Card>
        <CardTitle>Payroll run</CardTitle>
        <CardDescription className="mt-1">
          Xero isn&rsquo;t connected (or no organisation is selected), so hours can&rsquo;t be
          batched for a run. The read-only previews below keep working either way.
        </CardDescription>
        <p className="mt-3 border-t border-border pt-3 text-xs text-text-muted">
          <PreviewLinksRow fromDate={fromDate} toDate={toDate} />
        </p>
      </Card>
    );
  }
  if (loadState === "error" || !validation) {
    return (
      <Card>
        <CardTitle>Payroll run</CardTitle>
        <CardDescription className="mt-1">
          <span role="alert">Couldn&rsquo;t check this period — reload to retry.</span>
        </CardDescription>
      </Card>
    );
  }

  const v = validation;
  const csvHref = batch ? `/api/xero/payroll-export?batchId=${batch.id}&format=csv` : "#";
  const resultRows: SentRow[] = sendResult
    ? sendResult.map((w) => ({
        name: w.worker,
        outcome: w.outcome,
        tsId: w.xeroTimesheetId || null,
        detail: w.blocker?.message || null,
      }))
    : (stateWorkers ?? []).map((w) => {
        const outcome = w.status ?? w.lastOutcome;
        return {
          name: w.workerName,
          outcome,
          tsId: w.xeroTimesheetId,
          detail: exportTone(outcome) !== "success" ? (w.errorDetail ?? null) : null,
        };
      });

  return (
    <Card data-testid="payrun-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Payroll run</CardTitle>
        {batch ? (
          <Pill tone={batchChip(batch).tone}>{batchChip(batch).label}</Pill>
        ) : !v.ready ? (
          <Pill tone="danger">
            {v.errors.length} {v.errors.length === 1 ? "blocker" : "blockers"}
          </Pill>
        ) : null}
      </div>
      <CardDescription className="mt-1">
        Three steps: snapshot the approved hours, lock them, send draft timesheets to Xero.
      </CardDescription>
      {notClosed ? (
        <p className="mt-2 text-xs text-amber-900">
          Some days are still undecided — best to finish This week first.
        </p>
      ) : null}
      {banner ? (
        <p className="mt-3 rounded-card border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900" role="status">
          {banner}
        </p>
      ) : null}
      {error ? (
        <p className="mt-3 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900" role="alert">
          {error}
        </p>
      ) : null}
      {v.warnings.map((w) => (
        <p key={w.code} className="mt-3 rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {w.workers?.length ? <b className="font-semibold">{w.workers.join(", ")} — </b> : null}
          {w.message}
        </p>
      ))}

      <ol className="mt-5 list-none space-y-0 p-0">
        <StepRow
          n={1}
          state={stepIndex > 1 ? "done" : "current"}
          title="Create the batch"
          sub={
            batch
              ? `${batch.item_count} rows · ${n2(batch.total_hours)}h snapshotted`
              : "Freezes the approved hours for this period"
          }
        >
          {stepIndex === 1 ? (
            <div className="space-y-2">
              {v.errors.map((e) => (
                <p key={e.code} className="rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">
                  {e.message}
                </p>
              ))}
              {step === "correction" && batch ? (
                <p className="rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  This batch is blocked — delete it and create a fresh one.
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy !== null || !v.ready} onClick={() => void createBatch()} data-testid="payrun-create">
                  {busy === "create" ? "Creating…" : "Create batch"}
                </Button>
                {step === "correction" && batch ? (
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void deleteBatch()}>
                    Delete blocked batch
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </StepRow>

        <StepRow
          n={2}
          state={stepIndex > 2 ? "done" : stepIndex === 2 ? "current" : "todo"}
          title="Lock it"
          sub={
            batch?.locked_at
              ? `Locked by ${batch.locked_by_name || "admin"} — it can't change now`
              : "Makes the numbers final — corrections become a new batch"
          }
        >
          {stepIndex === 2 ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy !== null} onClick={() => void lockBatch()} data-testid="payrun-lock">
                {busy === "lock" ? "Locking…" : "Lock the batch"}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void deleteBatch()}>
                Delete
              </Button>
            </div>
          ) : null}
        </StepRow>

        <StepRow
          n={3}
          last
          state={stepIndex > 3 ? "done" : stepIndex === 3 ? "current" : "todo"}
          title="Send to Xero"
          sub={
            stepIndex > 3
              ? "Draft timesheets created — review and post the pay run in Xero"
              : "Creates draft timesheets in Xero — never a pay run"
          }
        >
          {stepIndex === 3 ? (
            !exportEnabled ? (
              <div className="space-y-2">
                <p className="rounded-card border border-border bg-surface-subtle px-3 py-2 text-xs text-text-muted">
                  The draft-timesheet send is switched off (xero_payroll_export). Download the
                  locked batch as CSV and enter it in Xero by hand, or flip the flag on.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <a href={csvHref} className="rounded-card border border-border px-3 py-1.5 text-sm font-medium text-text hover:border-brand-navy">
                    Download batch CSV
                  </a>
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void unlockBatch()}>
                    Unlock
                  </Button>
                </div>
              </div>
            ) : confirmSend ? (
              <div className="space-y-2 rounded-card border-2 border-brand-navy p-3" data-testid="payrun-confirm">
                <p className="text-sm text-text">
                  Create <b className="font-semibold">draft</b> timesheets in Xero from this locked
                  batch? No pay run, no STP — you post it in Xero.
                </p>
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy !== null} onClick={() => void send()} data-testid="payrun-send-confirm">
                    {busy === "send" ? "Sending…" : "Yes, send it"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmSend(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  className="bg-brand-xero text-white hover:bg-brand-xero-hover active:bg-brand-xero-hover"
                  onClick={() => setConfirmSend(true)}
                  data-testid="payrun-send"
                >
                  <UploadCloud aria-hidden="true" className="h-4 w-4" />
                  Send to Xero
                </Button>
                <a href={csvHref} className="rounded-card border border-border px-3 py-1.5 text-sm font-medium text-text hover:border-brand-navy">
                  Download CSV instead
                </a>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void unlockBatch()}>
                  Unlock
                </Button>
              </div>
            )
          ) : null}
          {stepIndex === 4 ? (
            <div className="space-y-2">
              {resultRows.length > 0 ? <SentWorkerRows rows={resultRows} /> : null}
              <div className="flex flex-wrap items-center gap-2">
                {exportEnabled && batch && ["partially_exported", "exporting"].includes(batch.status) ? (
                  <Button size="sm" disabled={busy !== null} onClick={() => void send()}>
                    {busy === "send" ? "Retrying…" : "Retry failed"}
                  </Button>
                ) : null}
                <a href={csvHref} className="rounded-card border border-border px-3 py-1.5 text-sm font-medium text-text hover:border-brand-navy">
                  Download batch CSV
                </a>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void correctionBatch()}>
                  New correction batch
                </Button>
              </div>
            </div>
          ) : null}
        </StepRow>
      </ol>

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-3 text-xs text-text-muted">
        {batch ? (
          <button
            type="button"
            onClick={() => void toggleRows()}
            className="font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
            data-testid="payrun-rows-toggle"
          >
            {showRows ? "Hide the rows" : "View the rows"}
          </button>
        ) : null}
        <PreviewLinksRow fromDate={fromDate} toDate={toDate} />
      </div>
      {showRows && items ? (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-text-muted">
                <th className="py-1 pr-3 font-medium">Date</th>
                <th className="py-1 pr-3 font-medium">Worker</th>
                <th className="py-1 pr-3 font-medium">Type</th>
                <th className="py-1 pr-3 font-medium">Job</th>
                <th className="py-1 pr-3 text-right font-medium">Hours</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i, idx) => (
                <tr key={idx} className="border-t border-border">
                  <td className="py-1 pr-3">{String(i.entry_date).slice(0, 10)}</td>
                  <td className="py-1 pr-3">{i.worker_name}</td>
                  <td className="py-1 pr-3">{i.work_type}</td>
                  <td className="py-1 pr-3">{i.job_name ?? "Internal"}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{n2(i.hours)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}
