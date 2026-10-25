"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatHoursLabel } from "@/domains/timesheets/format";
import {
  LEAVE_LABELS,
  dayDate,
  entryTarget,
  splitLabel,
  weekdayName,
  type DayRow,
  type HoursJob,
  type LeaveType,
} from "@/domains/timesheets/hours-view";
import type { TimeEntry } from "@/domains/timesheets/types";
import { LEAVE_ICON } from "./LeavePills";
import { StatusPill } from "./StatusPill";
import styles from "./hours.module.css";

/** Per-day app-side state the rows show on top of the stored entries. */
export type RowUiState = "saving" | "unconfirmed";

export interface WeekCardProps {
  rows: ReadonlyArray<DayRow>;
  pickedDate: string | null;
  rowState: Readonly<Record<string, RowUiState | undefined>>;
  /** The day that just became a receipt — it cross-fades in. */
  justSavedDate?: string | null;
  jobs: ReadonlyArray<HoursJob>;
  onPickDay: (date: string) => void;
  onOpenEntry: (entry: TimeEntry) => void;
  onTapUnconfirmed: (date: string) => void;
  testIdPrefix?: string;
}

/**
 * One white card holding Mon–Sun as rows (docs/phil-hours.md). Every row is a
 * real entry or a real calendar day; the row's words carry its state (status
 * word + icon, "Picked to log", "Not yet"), never colour alone. The picked day
 * is kept in view as it moves.
 */
export function HoursWeekCard(props: WeekCardProps): ReactNode {
  const {
    rows,
    pickedDate,
    rowState,
    justSavedDate = null,
    jobs,
    testIdPrefix = "hours-day",
  } = props;
  const pickedRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    pickedRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [pickedDate]);

  return (
    <ul
      className="divide-y divide-[#eef2f6] overflow-hidden rounded-[16px] border border-border bg-surface shadow-card"
      data-testid="hours-week-card"
    >
      {rows.map((row) => {
        const state = rowState[row.date];
        const picked = row.date === pickedDate && row.kind === "pickable" && !state;
        return (
          <li
            key={row.date}
            ref={picked ? pickedRef : undefined}
            data-testid={`${testIdPrefix}-${row.date}`}
            data-kind={state ?? row.kind}
            className={cn(row.date === justSavedDate && styles.receiptIn)}
          >
            {state === "saving" ? (
              <SavingRow date={row.date} />
            ) : state === "unconfirmed" ? (
              <UnconfirmedRow date={row.date} onTap={() => props.onTapUnconfirmed(row.date)} />
            ) : row.kind === "logged" && row.entry ? (
              row.entry.status === "rejected" ? (
                <FixRow
                  entry={row.entry}
                  jobs={jobs}
                  onOpen={() => props.onOpenEntry(row.entry!)}
                />
              ) : (
                <LoggedRow
                  entry={row.entry}
                  jobs={jobs}
                  onOpen={() => props.onOpenEntry(row.entry!)}
                />
              )
            ) : row.kind === "pickable" ? (
              <PickableRow row={row} picked={picked} onPick={() => props.onPickDay(row.date)} />
            ) : row.kind === "future" ? (
              <p className="flex min-h-[44px] items-center px-4 text-[14px] text-text-muted">
                {`${dayDate(row.date)} · Not yet`}
              </p>
            ) : (
              <p className="flex min-h-[44px] items-center px-4 text-[14px] text-text-muted">
                {`${dayDate(row.date)} · Not logged`}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function LoggedRow({
  entry,
  jobs,
  onOpen,
}: {
  entry: TimeEntry;
  jobs: ReadonlyArray<HoursJob>;
  onOpen: () => void;
}): ReactNode {
  const leave = (entry.dayType as LeaveType | null | undefined) ?? null;
  const LeaveIcon = leave ? LEAVE_ICON[leave] : null;
  const target = leave ? null : entryTarget(entry, jobs);
  const waiting = entry.status === "submitted";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${dayDate(entry.date)}, ${formatHoursLabel(entry.totalHours)}, ${leave ? LEAVE_LABELS[leave] : target}. Open this day`}
      className="flex min-h-[72px] w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-subtle"
    >
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 whitespace-nowrap font-display text-[16px] font-bold text-text">
            {dayDate(entry.date)}
          </span>
          <span className="min-w-0 truncate font-display text-[15px] font-bold tabular-nums text-text">
            {splitLabel(entry)}
          </span>
        </span>
        {leave && LeaveIcon ? (
          <span className="mt-1 inline-flex items-center gap-1 rounded-pill border border-border-strong px-2 py-0.5 text-[12px] font-semibold text-text">
            <LeaveIcon aria-hidden="true" className="h-3.5 w-3.5" />
            {LEAVE_LABELS[leave]}
          </span>
        ) : (
          // The job on its own line, so a long name is never squeezed to "…"
          // by the status pill beside it.
          <span className="mt-0.5 block truncate text-[14px] text-text-muted">
            {target}
            {waiting ? " · tap to change" : ""}
          </span>
        )}
      </span>
      <StatusPill state={entry.status} />
      <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
    </button>
  );
}

function FixRow({
  entry,
  jobs,
  onOpen,
}: {
  entry: TimeEntry;
  jobs: ReadonlyArray<HoursJob>;
  onOpen: () => void;
}): ReactNode {
  const day = weekdayName(entry.date);
  return (
    <div className="bg-[#fee2e2] px-4 py-3" data-testid="hours-fix-row">
      <div className="flex items-start justify-between gap-3">
        <span className="font-display text-[16px] font-bold text-text">{dayDate(entry.date)}</span>
        <StatusPill state="rejected" />
      </div>
      {entry.rejectedReason?.trim() ? (
        <p className="mt-1 text-[14px] text-text">{`The office says: “${entry.rejectedReason.trim()}”`}</p>
      ) : null}
      <p className="mt-1 text-[14px] tabular-nums text-text-muted">
        {`You sent ${formatHoursLabel(entry.totalHours)} · ${entryTarget(entry, jobs)}`}
      </p>
      <button
        type="button"
        onClick={onOpen}
        data-testid={`hours-fix-${entry.date}`}
        className="mt-2 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-card bg-state-danger px-4 font-display text-[15px] font-bold text-white active:opacity-90"
      >
        {`Fix ${day}`}
        <ChevronRight aria-hidden="true" className="h-4 w-4" />
      </button>
    </div>
  );
}

function PickableRow({
  row,
  picked,
  onPick,
}: {
  row: DayRow;
  picked: boolean;
  onPick: () => void;
}): ReactNode {
  const words = picked
    ? "Picked to log"
    : row.isToday
      ? "Today · not logged"
      : row.isTomorrow
        ? "Tomorrow"
        : "Not logged";
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={picked}
      aria-label={`${dayDate(row.date)}, ${words}${picked ? "" : ". Pick this day to log"}`}
      className={cn(
        "flex min-h-[64px] w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-200",
        picked ? "bg-brand-navy text-white" : "bg-surface text-text active:bg-surface-subtle"
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block font-display text-[16px] font-bold">{dayDate(row.date)}</span>
        <span className={cn("block text-[14px]", picked ? "text-white/85" : "text-text-muted")}>
          {words}
        </span>
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2",
          picked ? "border-white" : "border-border-strong"
        )}
      >
        {picked ? <span className="h-3 w-3 rounded-full bg-white" /> : null}
      </span>
    </button>
  );
}

function SavingRow({ date }: { date: string }): ReactNode {
  return (
    <div
      className="flex min-h-[64px] items-center gap-3 bg-brand-navy px-4 py-3 text-white"
      aria-live="polite"
    >
      <span className="min-w-0 flex-1 font-display text-[16px] font-bold">{dayDate(date)}</span>
      <StatusPill state="saving" />
    </div>
  );
}

function UnconfirmedRow({ date, onTap }: { date: string; onTap: () => void }): ReactNode {
  return (
    <button
      type="button"
      onClick={onTap}
      className="flex min-h-[64px] w-full items-center gap-3 bg-[#fef3c7] px-4 py-3 text-left active:opacity-90"
    >
      <span className="min-w-0 flex-1">
        <span className="block font-display text-[16px] font-bold text-text">{dayDate(date)}</span>
        <span className="block text-[14px] text-text">Tap to check and try again</span>
      </span>
      <StatusPill state="unconfirmed" />
    </button>
  );
}
