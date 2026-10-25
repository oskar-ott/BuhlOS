"use client";

import { useState, type ReactNode } from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatHoursLabel } from "@/domains/timesheets/format";
import {
  MAX_HOURS_PER_DAY,
  STANDARD_DAY_HOURS,
  STANDARD_DAY_MINUTES,
} from "@/domains/timesheets/service";
import {
  dayDate,
  hoursFromMinutes,
  minutesFromHours,
  weekdayName,
  type HoursJob,
} from "@/domains/timesheets/hours-view";
import type { HoursProblem } from "@/domains/timesheets/problem";
import { HmField } from "./HmField";
import { HoursSheet } from "./HoursSheet";

/**
 * Split jobs (docs/phil-hours.md): `1 · Day total` (the standard day, or a
 * different total as h + m), `2 · Hours on each job` — a row per job with h +
 * m and −15m / +15m, a `Change job` link per row, the LAST row read-only as
 * the remainder ("Worked out for you: day total minus the jobs before it"),
 * and `Add another job`. The worker never does the subtraction. OT is a
 * property of the day: the server splits it on the total.
 *
 * `onSubmit` hands back the total and the allocations (every row a real job,
 * every row > 0, rows summing to the total). In `pick` mode (the Fix sheet)
 * nothing is sent — the opener gets the split back.
 */
export interface SplitRowSeed {
  jobId: string | null;
  hours: number;
}

export function SplitSheet({
  open,
  onClose,
  date,
  jobs,
  defaultJobId,
  initialTotal = STANDARD_DAY_HOURS,
  initialRows,
  pick = false,
  busy = false,
  problem,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  date: string;
  jobs: ReadonlyArray<HoursJob>;
  defaultJobId: string | null;
  initialTotal?: number;
  initialRows?: ReadonlyArray<SplitRowSeed>;
  pick?: boolean;
  busy?: boolean;
  problem?: { problem: HoursProblem; onRetry?: (() => void) | null; retryLabel?: string } | null;
  onSubmit: (totalHours: number, allocations: Array<{ jobId: string; hours: number }>) => void;
}): ReactNode {
  const [totalMinutes, setTotalMinutes] = useState<number>(() => minutesFromHours(initialTotal));
  const [differentTotal, setDifferentTotal] = useState<boolean>(
    () => Math.abs(initialTotal - STANDARD_DAY_HOURS) > 0.005
  );
  // Rows: every row but the last carries typed minutes; the last is the
  // remainder. Seeded from the entry when fixing a split day, else the
  // default job first and a second row for the worker to fill.
  const [rows, setRows] = useState<Array<{ jobId: string | null; minutes: number }>>(() => {
    if (initialRows && initialRows.length >= 2) {
      return initialRows.map((r) => ({ jobId: r.jobId, minutes: minutesFromHours(r.hours) }));
    }
    const other = jobs.find((j) => j.id !== defaultJobId) ?? null;
    return [
      { jobId: defaultJobId, minutes: 0 },
      { jobId: other?.id ?? null, minutes: 0 },
    ];
  });
  const [changingRow, setChangingRow] = useState<number | null>(null);

  const earlier = rows.slice(0, -1);
  const usedMinutes = earlier.reduce((s, r) => s + r.minutes, 0);
  const remainderMinutes = Math.max(0, totalMinutes - usedMinutes);
  const effectiveMinutes = (i: number) =>
    i === rows.length - 1 ? remainderMinutes : rows[i]!.minutes;

  const jobName = (id: string | null) => jobs.find((j) => j.id === id)?.name ?? null;
  const taken = new Set(rows.map((r) => r.jobId).filter(Boolean) as string[]);
  const canAdd = jobs.some((j) => !taken.has(j.id));

  // Why the day can't be sent yet, in order of what the worker fixes first.
  let reason: string | null = null;
  if (totalMinutes <= 0) reason = "Set the day total to send.";
  else if (totalMinutes > MAX_HOURS_PER_DAY * 60)
    reason = `Most in a day: ${MAX_HOURS_PER_DAY}h. Take some off to send.`;
  else if (rows.some((r) => !r.jobId)) reason = "Pick a job for every row to send.";
  else if (new Set(rows.map((r) => r.jobId)).size !== rows.length)
    reason = "Each job can only be on one row.";
  else if (earlier.some((r) => r.minutes <= 0))
    reason = "Set the hours on each job — the last job gets the remainder.";
  else if (usedMinutes >= totalMinutes)
    reason =
      "The jobs before the last one use the whole day — take some off so the remainder is more than 0.";

  const totalHours = hoursFromMinutes(totalMinutes);
  const receipt = `${dayDate(date)} · ${rows
    .map(
      (r, i) =>
        `${jobName(r.jobId) ?? "Pick a job"} ${formatHoursLabel(hoursFromMinutes(effectiveMinutes(i)))}`
    )
    .join(" + ")} · ${formatHoursLabel(totalHours)} total`;

  function submit() {
    if (reason) return;
    onSubmit(
      totalHours,
      rows.map((r, i) => ({
        jobId: r.jobId as string,
        hours: hoursFromMinutes(effectiveMinutes(i)),
      }))
    );
  }

  const step =
    "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-card border border-border-strong bg-surface text-text active:bg-surface-subtle disabled:opacity-40";

  return (
    <HoursSheet
      open={open}
      onClose={onClose}
      title="Split jobs"
      subtitle={`${dayDate(date)} · ${rows.length} jobs`}
      testId="hours-sheet-split"
      nested={pick}
      footer={{
        problem: problem ?? null,
        review: reason ? null : { lead: "You're sending", line: receipt },
        reason,
        send: {
          label: pick
            ? `Use these ${rows.length} jobs`
            : `Send ${weekdayName(date)} · ${rows.length} jobs`,
          sub: pick ? undefined : "Goes to the office",
          onClick: submit,
          busy,
          testId: "hours-split-send",
        },
      }}
    >
      <div className="space-y-5">
        <section>
          <h3 className="mb-2 font-display text-[15px] font-bold">1 · Day total</h3>
          <div role="radiogroup" aria-label="Day total" className="grid grid-cols-2 gap-2">
            <Option
              active={!differentTotal}
              onClick={() => {
                setDifferentTotal(false);
                setTotalMinutes(STANDARD_DAY_MINUTES);
              }}
              label="Standard day"
              caption={formatHoursLabel(STANDARD_DAY_HOURS)}
            />
            <Option
              active={differentTotal}
              onClick={() => setDifferentTotal(true)}
              label="Different total"
              caption="set hours + minutes"
            />
          </div>
          {differentTotal ? (
            <div className="mt-3">
              <HmField
                label="Day total"
                minutes={totalMinutes}
                onChange={setTotalMinutes}
                minuteStep={15}
                maxMinutes={MAX_HOURS_PER_DAY * 60}
                testId="hours-split-total"
              />
            </div>
          ) : null}
        </section>

        <section>
          <h3 className="mb-2 font-display text-[15px] font-bold">2 · Hours on each job</h3>
          <ul className="space-y-2">
            {rows.map((row, i) => {
              const last = i === rows.length - 1;
              const name = jobName(row.jobId);
              return (
                <li
                  key={i}
                  className="rounded-[16px] border border-border bg-surface p-3"
                  data-testid={`hours-split-row-${i}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 font-display text-[16px] font-bold">
                      {name ?? <span className="text-state-warning">Pick a job</span>}
                    </p>
                    <button
                      type="button"
                      onClick={() => setChangingRow(changingRow === i ? null : i)}
                      aria-expanded={changingRow === i}
                      className="min-h-[44px] shrink-0 px-2 font-display text-[14px] font-semibold text-brand-navy underline-offset-2 active:underline"
                    >
                      {name ? "Change job" : "Pick job"}
                    </button>
                  </div>
                  {changingRow === i ? (
                    <ul className="mt-2 divide-y divide-[#eef2f6] overflow-hidden rounded-card border border-border">
                      {jobs
                        .filter((j) => !taken.has(j.id) || j.id === row.jobId)
                        .map((j) => (
                          <li key={j.id}>
                            <button
                              type="button"
                              onClick={() => {
                                setRows((prev) =>
                                  prev.map((r, k) => (k === i ? { ...r, jobId: j.id } : r))
                                );
                                setChangingRow(null);
                              }}
                              className={cn(
                                "flex min-h-[48px] w-full items-center px-3 text-left text-[15px]",
                                j.id === row.jobId
                                  ? "bg-brand-navy font-semibold text-white"
                                  : "text-text active:bg-surface-subtle"
                              )}
                            >
                              {j.name}
                            </button>
                          </li>
                        ))}
                    </ul>
                  ) : null}
                  {last ? (
                    <div className="mt-2">
                      <p
                        className="font-display text-[18px] font-bold tabular-nums"
                        data-testid="hours-split-remainder"
                      >
                        {`remainder · ${formatHoursLabel(hoursFromMinutes(remainderMinutes))}`}
                      </p>
                      <p className="text-[13px] text-text-muted">
                        Worked out for you: day total minus the jobs before it
                      </p>
                    </div>
                  ) : (
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setRows((p) =>
                            p.map((r, k) =>
                              k === i ? { ...r, minutes: Math.max(0, r.minutes - 15) } : r
                            )
                          )
                        }
                        disabled={row.minutes <= 0}
                        aria-label={`Take 15 minutes off ${name ?? "this job"}`}
                        className={step}
                      >
                        <Minus aria-hidden="true" className="h-5 w-5" />
                      </button>
                      <span
                        className="min-w-0 flex-1 text-center font-display text-[18px] font-bold tabular-nums"
                        aria-live="polite"
                      >
                        {formatHoursLabel(hoursFromMinutes(row.minutes))}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setRows((p) =>
                            p.map((r, k) => (k === i ? { ...r, minutes: r.minutes + 15 } : r))
                          )
                        }
                        disabled={usedMinutes + 15 >= totalMinutes}
                        aria-label={`Add 15 minutes to ${name ?? "this job"}`}
                        className={step}
                      >
                        <Plus aria-hidden="true" className="h-5 w-5" />
                      </button>
                      {rows.length > 2 ? (
                        <button
                          type="button"
                          onClick={() => setRows((p) => p.filter((_r, k) => k !== i))}
                          className="min-h-[44px] shrink-0 px-2 text-[14px] font-semibold text-text-muted"
                        >
                          Remove
                        </button>
                      ) : null}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {canAdd ? (
            <button
              type="button"
              onClick={() => {
                const next = jobs.find((j) => !taken.has(j.id));
                if (next) setRows((p) => [...p, { jobId: next.id, minutes: 0 }]);
              }}
              data-testid="hours-split-add"
              className="mt-2 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-card border border-dashed border-border-strong font-display text-[15px] font-semibold text-text active:bg-surface-subtle"
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              Add another job
            </button>
          ) : null}
        </section>
      </div>
    </HoursSheet>
  );
}

function Option({
  active,
  onClick,
  label,
  caption,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  caption: string;
}): ReactNode {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "flex min-h-[56px] items-center gap-2 rounded-card border px-3 text-left",
        active
          ? "border-brand-navy bg-brand-navy text-white"
          : "border-border-strong bg-surface text-text active:bg-surface-subtle"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
          active ? "border-white" : "border-border-strong"
        )}
      >
        {active ? <span className="h-2 w-2 rounded-full bg-white" /> : null}
      </span>
      <span className="min-w-0">
        <span className="block font-display text-[15px] font-bold">{label}</span>
        <span
          className={cn(
            "block text-[12px] tabular-nums",
            active ? "text-white/80" : "text-text-muted"
          )}
        >
          {caption}
        </span>
      </span>
    </button>
  );
}
