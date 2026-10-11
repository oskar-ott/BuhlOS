"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { DAY_TYPE_LABELS, formatHoursLabel } from "@/domains/timesheets/format";
import type { FixDayType } from "@/domains/timesheets/resubmit";
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
 *
 * The DAY can be switched too (owner pull 2026-10-11 — the 5 Oct public
 * holiday logged as a job day): given `dayTypeOptions`, a "This day" row
 * offers Sick day / Holiday (TAFE day for an apprentice). A job-less day is
 * one time, no job, all ordinary — the server books it so. "Job day" is
 * offered only when the day WAS job work (it restores those jobs); a day
 * already logged as leave goes back to job work through the worker, who knows
 * the job.
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
  /** Set only when the fix switches what the day IS (a sick day, holiday or
   *  TAFE day); absent keeps the day's type as it was. */
  dayType?: FixDayType;
}

/**
 * What a fix sends — pure, so a switch's payload is pinned by tests. A
 * job-less day is ONE time on no job; `dayType` rides only when the fix
 * changes what the day is (absent keeps it, server-side).
 */
export function amendDayPayload(input: {
  type: FixDayType | null;
  initialType: FixDayType | null;
  rows: ReadonlyArray<{ jobId: string | null; hours: number }>;
  typeHours: number;
  reason: string;
}): AmendPayload {
  const { type, initialType, rows, typeHours } = input;
  const totalHours =
    type === null
      ? Math.round(rows.reduce((s, r) => s + r.hours, 0) * 100) / 100
      : Math.round(typeHours * 100) / 100;
  return {
    totalHours,
    allocations:
      type === null
        ? rows.map((r) => ({ jobId: r.jobId, hours: r.hours }))
        : [{ jobId: null, hours: totalHours }],
    reason: input.reason.trim(),
    ...(type !== null && type !== initialType ? { dayType: type } : {}),
  };
}

const SWITCH_REASON_HINT: Record<FixDayType, string> = {
  holiday: "e.g. Public holiday — not a job day",
  sick: "e.g. Off sick — logged on a job by mistake",
  tafe: "e.g. At TAFE — logged on a job by mistake",
};

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
  dayType = null,
  dayTypeOptions = [],
}: {
  dateLabel: string;
  workerName: string;
  currentTotalHours: number;
  allocations: ReadonlyArray<AmendAllocationInput>;
  saving: boolean;
  onCancel: () => void;
  onSave: (payload: AmendPayload) => void;
  /** What the day is now: a job-less type, or null for job work. */
  dayType?: FixDayType | null;
  /** The types the fix may switch the day to — none → no "This day" row. */
  dayTypeOptions?: ReadonlyArray<FixDayType>;
}): ReactNode {
  const [rows, setRows] = useState<AmendRow[]>(() =>
    allocations.map((a) => {
      const { hours, minutes } = splitHoursMinutes(Number(a.hours) || 0);
      return { jobId: a.jobId, label: a.label, hours, minutes };
    }),
  );
  const [reason, setReason] = useState("");
  // What the day will be: a job-less type, or null for job work.
  const [type, setType] = useState<FixDayType | null>(dayType);
  // A job-less day's one time, kept apart from the job rows so switching to a
  // holiday and back restores the jobs exactly as they were.
  const [typeTime, setTypeTime] = useState(() =>
    splitHoursMinutes(Number(currentTotalHours) || 0),
  );
  const switched = type !== dayType;
  const split = type === null && rows.length > 1;

  const jobTotal = useMemo(
    () => Math.round(rows.reduce((s, r) => s + hoursFromHm(r.hours, r.minutes), 0) * 100) / 100,
    [rows],
  );
  const total =
    type === null
      ? jobTotal
      : Math.round(hoursFromHm(typeTime.hours, typeTime.minutes) * 100) / 100;
  const totalInvalid = total <= 0 || total > MAX_HOURS_PER_DAY;
  const anyZeroRow = type === null && rows.some((r) => hoursFromHm(r.hours, r.minutes) <= 0);
  const reasonMissing = reason.trim().length === 0;
  const unchanged = !split && !switched && Math.abs(total - Number(currentTotalHours)) <= 0.005;
  const blocked = totalInvalid || anyZeroRow || reasonMissing || saving;
  // "Job day" only restores jobs the day really had.
  const choices: Array<FixDayType | null> =
    dayTypeOptions.length === 0
      ? []
      : [...(dayType === null ? [null] : []), ...dayTypeOptions];

  function pickType(next: FixDayType | null) {
    // Leaving job work carries the time over; the job rows stay put for the
    // way back.
    if (type === null && next !== null) setTypeTime(splitHoursMinutes(jobTotal));
    setType(next);
  }

  function setRow(i: number, patch: Partial<AmendRow>) {
    setRows((current) => current.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function save() {
    if (blocked) return;
    onSave(
      amendDayPayload({
        type,
        initialType: dayType,
        rows: rows.map((r) => ({ jobId: r.jobId, hours: hoursFromHm(r.hours, r.minutes) })),
        typeHours: hoursFromHm(typeTime.hours, typeTime.minutes),
        reason,
      }),
    );
  }

  return (
    <div
      data-testid="amend-editor"
      className="space-y-3 rounded-card border border-border bg-surface-subtle p-3"
    >
      <p className="text-sm font-medium text-text">Fix the hours for {dateLabel}</p>

      {choices.length > 0 ? (
        <div data-testid="amend-daytypes">
          <p className="mb-1 text-sm font-medium text-text">This day</p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="What this day is">
            {choices.map((t) => {
              const active = t === type;
              return (
                <button
                  key={t ?? "job"}
                  type="button"
                  onClick={() => pickType(t)}
                  disabled={saving}
                  aria-pressed={active}
                  data-testid={`amend-daytype-${t ?? "job"}`}
                  className={cn(
                    "min-h-[44px] rounded-pill border px-3 text-sm font-medium disabled:opacity-60",
                    active
                      ? "border-brand-navy bg-brand-navy text-text-inverse"
                      : "border-border bg-surface text-text hover:border-border-strong",
                  )}
                >
                  {t === null ? "Job day" : t === "tafe" ? "TAFE day" : DAY_TYPE_LABELS[t]}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {type !== null ? (
        <fieldset className="block text-sm" data-testid={`amend-type-time-${type}`}>
          <legend className="mb-1 block font-medium text-text">{`${DAY_TYPE_LABELS[type]} hours`}</legend>
          <div className="flex items-center gap-2">
            <label className="flex flex-1 items-center gap-2">
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_HOURS_PER_DAY}
                step={1}
                value={typeTime.hours}
                onChange={(e) =>
                  setTypeTime((t) => ({ ...t, hours: Math.max(0, Math.floor(Number(e.target.value) || 0)) }))
                }
                aria-label="Hours"
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
                value={typeTime.minutes}
                onChange={(e) =>
                  setTypeTime((t) => ({
                    ...t,
                    minutes: Math.min(59, Math.max(0, Math.floor(Number(e.target.value) || 0))),
                  }))
                }
                aria-label="Minutes"
                className="h-11 w-full rounded-card border border-border bg-surface px-3 text-base focus:border-brand-navy focus:outline-none"
              />
              <span className="shrink-0 text-text-muted">m</span>
            </label>
          </div>
        </fieldset>
      ) : null}

      {type === null && rows.map((row, i) => (
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
      {switched && type !== null ? (
        // P12 — the switch names what it does before it's saved.
        <p className="text-xs font-medium text-text" data-testid="amend-switch-consequence">
          {`Becomes ${type === "holiday" ? "a holiday" : type === "sick" ? "a sick day" : "a TAFE day"} — no job, all ordinary time.`}
        </p>
      ) : null}
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
          placeholder={switched && type !== null ? SWITCH_REASON_HINT[type] : "e.g. Typo — you meant 8h 36m"}
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
