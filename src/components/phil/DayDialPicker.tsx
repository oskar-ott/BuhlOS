"use client";

import { DialPicker } from "./DialPicker";
import type { LogDayDialOption } from "@/domains/timesheets/service";

/**
 * The day dial on the log sheet (owner-directed 2026-08-09): the SAME drum
 * as the job picker, offering ONLY this week's days by name ("Today",
 * "Friday", "Thursday"…) instead of a free calendar — a worker can't
 * mis-pick a date that isn't offered. Options come from the pure
 * logDayDialOptions (today first; an older week's "Log" pill seeds its exact
 * day as an extra dated row).
 */
export function DayDialPicker({
  options,
  selectedDate,
  onSelect,
  disabled,
}: {
  options: ReadonlyArray<LogDayDialOption>;
  selectedDate: string;
  onSelect: (date: string) => void;
  disabled: boolean;
}) {
  return (
    <DialPicker
      items={options.map((o) => ({ id: o.date, label: o.label }))}
      selectedId={selectedDate}
      onSelect={onSelect}
      disabled={disabled}
      ariaLabel="Choose the day to log"
      countNoun="days"
      testId="day-dial"
    />
  );
}
