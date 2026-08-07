"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { formatHoursLabel } from "@/domains/timesheets/format";
import {
  MAX_HOURS_PER_DAY,
  hoursFromHm,
  splitHoursMinutes,
} from "@/domains/timesheets/service";

/**
 * "Fix the hours" — the office's correct-and-approve editor for ONE day.
 *
 * ONE implementation, both approval surfaces (/hours/approvals queue and the
 * /hours/weekly phone stepper), so the two can never disagree about what a
 * correction means or how it rounds.
 *
 * HOURS + MINUTES fields, never a decimal box. The incident behind this whole
 * capability was a worker typing "8.36" meaning 8h 36m into a decimal field
 * that read it as 8h 22m; the office's fix-it tool must not be able to repeat
 * the same mistake, so it speaks the site's duration dialect exactly as the
 * field app now does (src/components/phil/LogHoursSheet.tsx).
 *
 * A day split across jobs edits EACH job's time and derives the total; a
 * single-job day edits the one time. Either way the reason is REQUIRED — it
 * travels to the worker with the change, because pay never moves invisibly.
 */

export interface AmendAllocationInput {
  jobId: string | null;
  /** What this allocation is called on screen — a real job name, never a guess. */
  label: string;
  hours: number;
}

export interface AmendPayload {
  totalHours: number;
  allocations: Array<{ jobId: string | null; hours: number }>;
  reason: string;
}

/** One editable allocation, held as hours + minutes (never a decimal). */
interface AmendRow extends AmendAllocationInput {
  minutes: number;
}

export function AmendHoursEditor({
  dateLabel,
  workerName,
  currentTotalHours,
  allocations,
  saving,
  onCancel,
  onSave,
}: {
  dateLabel: string;
  workerName: string;
  currentTotalHours: number;
  allocations: ReadonlyArray<AmendAllocationInput>;
  saving: boolean;
  onCancel: () => void;
  onSave: (payload: AmendPayload) => void;
}): ReactNode {
  const [rows, setRows] = useState<AmendRow[]>(() =>
    allocations.map((a) => {
      const { hours, minutes } = splitHoursMinutes(Number(a.hours) || 0);
      return { jobId: a.jobId, label: a.label, hours, minutes };
    }),
  );
  const [reason, setReason] = useState("");
  const split = rows.length > 1;

  const total = useMemo(
    () => Math.round(rows.reduce((s, r) => s + hoursFromHm(r.hours, r.minutes), 0) * 100) / 100,
    [rows],
  );
  const totalInvalid = total <= 0 || total > MAX_HOURS_PER_DAY;
  const anyZeroRow = rows.some((r) => hoursFromHm(r.hours, r.minutes) <= 0);
  const reasonMissing = reason.trim().length === 0;
  const unchanged = !split && Math.abs(total - Number(currentTotalHours)) <= 0.005;
  const blocked = totalInvalid || anyZeroRow || reasonMissing || saving;

  function setRow(i: number, patch: Partial<AmendRow>) {
    setRows((current) => current.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function save() {
    if (blocked) return;
    onSave({
      totalHours: total,
      allocations: rows.map((r) => ({ jobId: r.jobId, hours: hoursFromHm(r.hours, r.minutes) })),
      reason: reason.trim(),
    });
  }

  return (
    <div
      data-testid="amend-editor"
      className="space-y-3 rounded-card border border-border bg-surface-subtle p-3"
    >
      <p className="text-sm font-medium text-text">Fix the hours for {dateLabel}</p>

      {rows.map((row, i) => (
        <fieldset key={`${row.jobId ?? "none"}-${i}`} className="block text-sm">
          <legend className="mb-1 block font-medium text-text">
            {split ? row.label : "Time worked"}
          </legend>
          <div className="flex items-center gap-2">
            <label className="flex flex-1 items-center gap-2">
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_HOURS_PER_DAY}
                step={1}
                value={row.hours}
                onChange={(e) =>
                  setRow(i, { hours: Math.max(0, Math.floor(Number(e.target.value) || 0)) })
                }
                aria-label={split ? `Hours on ${row.label}` : "Hours"}
                className="h-11 w-full rounded-card border border-border bg-surface px-3 text-base focus:border-brand-navy focus:outline-none"
              />
              <span className="shrink-0 text-text-muted">h</span>
            </label>
            <label className="flex flex-1 items-center gap-2">
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={59}
                step={1}
                value={row.minutes}
                onChange={(e) =>
                  setRow(i, {
                    minutes: Math.min(59, Math.max(0, Math.floor(Number(e.target.value) || 0))),
                  })
                }
                aria-label={split ? `Minutes on ${row.label}` : "Minutes"}
                className="h-11 w-full rounded-card border border-border bg-surface px-3 text-base focus:border-brand-navy focus:outline-none"
              />
              <span className="shrink-0 text-text-muted">m</span>
            </label>
          </div>
        </fieldset>
      ))}

      <p className="text-xs text-text-muted">
        {/* One string, not adjacent JSX text — SSR comment markers would split it. */}
        {`Was ${formatHoursLabel(currentTotalHours)} · now ${formatHoursLabel(total)}`}
      </p>
      {totalInvalid ? (
        <p role="alert" className="text-xs font-medium text-state-danger">
          {`Time must be between 0 and ${MAX_HOURS_PER_DAY} hours.`}
        </p>
      ) : null}
      {!totalInvalid && anyZeroRow ? (
        <p role="alert" className="text-xs font-medium text-state-danger">
          Every job on this day needs some time on it.
        </p>
      ) : null}
      {!totalInvalid && !anyZeroRow && unchanged ? (
        <p className="text-xs text-text-muted">
          Nothing&rsquo;s changed yet — approve it as it stands, or set the real time.
        </p>
      ) : null}

      <label className="block text-sm">
        <span className="mb-1 block font-medium text-text">Why (required)</span>
        <textarea
          required
          aria-required="true"
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Typo — you meant 8h 36m"
          className="block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm focus:border-brand-navy focus:outline-none"
        />
      </label>
      <p className="text-xs text-text-muted">
        {`${workerName} sees this change and the reason on their phone.`}
      </p>

      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={save} disabled={blocked} data-testid="amend-save">
          {saving ? "Saving…" : "Save & approve"}
        </Button>
      </div>
    </div>
  );
}
