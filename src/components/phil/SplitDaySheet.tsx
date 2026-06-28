"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { formatHoursLabel } from "@/domains/timesheets/format";
import { splitDayRemainder, STANDARD_DAY_HOURS } from "@/domains/timesheets/service";
import { useSheetHistory } from "./useSheetHistory";

/**
 * Split a day across 2+ jobs (#128) — opened from the log sheet's "More
 * options" only when the worker has more than one assigned job, so the 90%
 * one-job case never sees it. The day TOTAL is set once; the last row is the
 * auto-computed remainder, so the worker never does subtraction. Every row
 * must carry a picked job and positive hours, and the rows must sum to the
 * total before submit — the same allocation rules the server already enforces.
 */

interface SplitRow {
  jobId: string | null;
  /** Raw hours for non-last rows; the last row is computed. */
  hours: number;
}

interface SplitDaySheetProps {
  open: boolean;
  onClose: () => void;
  assignedJobs: ReadonlyArray<{ id: string; name: string }>;
  submitting: boolean;
  /** Parent runs the same submit/handleResult path the single-job flow uses. */
  onSubmit: (totalHours: number, allocations: Array<{ jobId: string; hours: number }>) => void;
  /** Modal title. Defaults to the create-path wording. */
  title?: string;
  /** Pre-fill the day total — used by the fix-and-resubmit flow (#128). */
  initialTotal?: number;
  /** Pre-fill the rows (2+) — used when resubmitting a rejected split day. A
   *  row whose job is no longer assigned should be passed `jobId: null`. */
  initialRows?: ReadonlyArray<{ jobId: string | null; hours: number }>;
  /** Server-side resubmit error to surface above the actions. */
  errorMessage?: string | null;
  /**
   * Opt in to sheet back-safety (#149): a swipe-back / Android back closes the
   * sheet instead of navigating. ONLY the user-toggled "Split the day" path in
   * LogHoursSheet sets this. The rejected-split RESUBMIT path
   * (RejectedHoursResubmitSheet) leaves it false on purpose — that open is
   * driven by the ?fixDate= URL flow, whose history contract must not be
   * touched. Default false keeps every existing caller unchanged.
   */
  backSafe?: boolean;
}

const MAX_TOTAL = 24;

export function SplitDaySheet({
  open,
  onClose,
  assignedJobs,
  submitting,
  onSubmit,
  title = "Split the day across jobs",
  initialTotal,
  initialRows,
  errorMessage = null,
  backSafe = false,
}: SplitDaySheetProps) {
  // Back-safety only when opted in (the user-toggled split path). When off, the
  // hook is given a never-open contract so it pushes nothing — keeping the
  // ?fixDate=-driven resubmit open on its existing history contract.
  const { closeWithHistory } = useSheetHistory({
    open: backSafe && open,
    onClose,
  });
  const close = backSafe ? closeWithHistory : onClose;
  const [total, setTotal] = useState<number>(initialTotal ?? STANDARD_DAY_HOURS);
  const [rows, setRows] = useState<SplitRow[]>(() =>
    initialRows && initialRows.length >= 2
      ? initialRows.map((r) => ({ jobId: r.jobId, hours: r.hours }))
      : [
          { jobId: null, hours: Math.round(STANDARD_DAY_HOURS * 0.6 * 10) / 10 },
          { jobId: null, hours: 0 },
        ],
  );
  const [showErrors, setShowErrors] = useState(false);

  // The last row is the remainder of all earlier rows — computed, never typed.
  const earlier = rows.slice(0, -1);
  const remainder = splitDayRemainder(total, earlier.map((r) => r.hours));
  const effectiveHours = (idx: number): number =>
    idx === rows.length - 1 ? remainder : rows[idx]!.hours;

  const sum = useMemo(
    () => rows.reduce((s, _r, i) => s + effectiveHours(i), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, total, remainder]
  );
  const sumOk = Math.abs(sum - total) < 0.01;
  const canAddMore = rows.length < assignedJobs.length;

  function rowError(idx: number): string | null {
    const jobId = rows[idx]!.jobId;
    if (!jobId) return "Pick a job for these hours.";
    // Defence-in-depth (the server gates too): the row's job must still be one of
    // the worker's active assigned jobs — catches a stale assignment that changed
    // since the sheet opened, before it round-trips. Mirrors the single-job guard.
    if (!assignedJobs.some((j) => j.id === jobId)) {
      return "That job isn’t assigned to you anymore — pick another.";
    }
    if (effectiveHours(idx) <= 0) return "Hours must be more than zero.";
    return null;
  }
  const anyError = rows.some((_r, i) => rowError(i) !== null) || !sumOk;

  /** Jobs not already chosen in another row (so the same job can't be picked twice). */
  function availableJobs(idx: number) {
    const taken = new Set(rows.filter((_r, i) => i !== idx).map((r) => r.jobId).filter(Boolean));
    return assignedJobs.filter((j) => !taken.has(j.id) || rows[idx]!.jobId === j.id);
  }

  function setRow(idx: number, patch: Partial<SplitRow>) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function addRow() {
    if (!canAddMore) return;
    setRows((prev) => [...prev, { jobId: null, hours: 0 }]);
  }
  function removeRow(idx: number) {
    setRows((prev) => (prev.length <= 2 ? prev : prev.filter((_r, i) => i !== idx)));
  }

  function submit() {
    setShowErrors(true);
    if (anyError || total <= 0 || total > MAX_TOTAL) return;
    onSubmit(
      total,
      rows.map((r, i) => ({ jobId: r.jobId as string, hours: effectiveHours(i) }))
    );
  }

  const inputClass =
    "h-11 rounded-card border border-border bg-surface px-2 text-sm focus:border-brand-navy focus:outline-none";

  return (
    <Modal open={open} onClose={close} title={title}>
      <div className="space-y-4" data-testid="split-day-sheet">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-text">Total hours for the day</span>
          <input
            type="number"
            min={0}
            max={MAX_TOTAL}
            step="0.1"
            value={total}
            onChange={(e) => setTotal(Number(e.target.value))}
            className={`h-12 w-full ${inputClass}`}
            data-testid="split-total"
          />
        </label>

        <ul className="space-y-2">
          {rows.map((row, idx) => {
            const isLast = idx === rows.length - 1;
            const err = showErrors ? rowError(idx) : null;
            return (
              <li key={idx} className="rounded-card border border-border p-2">
                <div className="grid grid-cols-[1fr_84px_auto] items-center gap-2">
                  <select
                    value={row.jobId ?? ""}
                    onChange={(e) => setRow(idx, { jobId: e.target.value || null })}
                    aria-label={`Job for row ${idx + 1}`}
                    data-testid={`split-job-${idx}`}
                    className={`${inputClass} w-full`}
                  >
                    <option value="">— Pick a job —</option>
                    {availableJobs(idx).map((j) => (
                      <option key={j.id} value={j.id}>
                        {j.name}
                      </option>
                    ))}
                  </select>
                  {isLast ? (
                    <span
                      className="flex h-11 items-center justify-center rounded-card bg-surface-subtle px-2 text-sm font-medium tabular-nums text-text"
                      data-testid={`split-remainder`}
                      title="Remainder — computed automatically"
                    >
                      {formatHoursLabel(remainder)}
                    </span>
                  ) : (
                    <input
                      type="number"
                      min={0}
                      max={MAX_TOTAL}
                      step="0.1"
                      value={row.hours}
                      onChange={(e) => setRow(idx, { hours: Number(e.target.value) })}
                      aria-label={`Hours for row ${idx + 1}`}
                      data-testid={`split-hours-${idx}`}
                      className={`${inputClass} w-full text-right tabular-nums`}
                    />
                  )}
                  {rows.length > 2 && !isLast ? (
                    <button
                      type="button"
                      onClick={() => removeRow(idx)}
                      aria-label={`Remove row ${idx + 1}`}
                      className="inline-flex h-11 w-9 items-center justify-center text-text-muted"
                    >
                      ✕
                    </button>
                  ) : (
                    <span className="w-9" aria-hidden="true" />
                  )}
                </div>
                {err ? <p className="mt-1 text-xs text-state-danger">{err}</p> : null}
              </li>
            );
          })}
        </ul>

        {canAddMore ? (
          <Button variant="secondary" size="sm" onClick={addRow} data-testid="split-add-job">
            Add another job
          </Button>
        ) : null}

        {showErrors && !sumOk ? (
          <p className="text-xs text-state-danger" data-testid="split-sum-error">
            The rows add up to {formatHoursLabel(sum)}, not {formatHoursLabel(total)}. Adjust the hours.
          </p>
        ) : null}

        {errorMessage ? (
          <p className="text-sm text-state-danger" role="alert" data-testid="split-error">
            {errorMessage}
          </p>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting} data-testid="split-submit">
            {submitting ? "Submitting…" : `Submit ${formatHoursLabel(total)}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
