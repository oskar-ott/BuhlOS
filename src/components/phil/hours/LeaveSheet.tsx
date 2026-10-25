"use client";

import { useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { formatHoursLabel } from "@/domains/timesheets/format";
import { STANDARD_DAY_HOURS } from "@/domains/timesheets/service";
import {
  LEAVE_CONSEQUENCE,
  LEAVE_LABELS,
  dayDate,
  leaveOptions,
  weekdayName,
  type LeaveType,
} from "@/domains/timesheets/hours-view";
import type { HoursProblem } from "@/domains/timesheets/problem";
import { HoursSheet } from "./HoursSheet";
import { LeavePills } from "./LeavePills";

/**
 * Sick day / Holiday / TAFE day (docs/phil-hours.md): opened from the action
 * bar with that option already picked. The options live in their own dashed
 * "Not a job day" group — never beside a job — and picking one says what it
 * means for pay before anything is sent. A leave day carries the standard
 * day (7h 36m) and goes to payroll as leave.
 */
export function LeaveSheet({
  open,
  onClose,
  date,
  preset,
  canLogTafe,
  busy = false,
  problem,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  date: string;
  preset: LeaveType;
  canLogTafe: boolean;
  busy?: boolean;
  problem?: { problem: HoursProblem; onRetry?: (() => void) | null; retryLabel?: string } | null;
  onSubmit: (type: LeaveType, note: string | null) => void;
}): ReactNode {
  const [type, setType] = useState<LeaveType>(preset);
  const [note, setNote] = useState("");
  const day = weekdayName(date);
  const label = LEAVE_LABELS[type];
  const receipt = `${dayDate(date)} · ${label} · ${formatHoursLabel(STANDARD_DAY_HOURS)}`;
  const article = type === "holiday" ? "a holiday" : type === "tafe" ? "a TAFE day" : "a sick day";
  const payroll =
    type === "holiday"
      ? "Goes to payroll as holiday leave"
      : type === "tafe"
        ? "Goes to payroll as a paid TAFE day"
        : "Goes to payroll as sick leave";

  return (
    <HoursSheet
      open={open}
      onClose={onClose}
      title={label}
      subtitle={dayDate(date)}
      testId="hours-sheet-leave"
      footer={{
        problem: problem ?? null,
        review: { lead: "You're sending", line: receipt },
        send: {
          label: `Send ${day} as ${article}`,
          sub: payroll,
          onClick: () => onSubmit(type, note.trim() || null),
          busy,
          testId: "hours-leave-send",
        },
      }}
    >
      <div className="space-y-4">
        <LeavePills options={leaveOptions(canLogTafe)} selected={type} onSelect={setType} />
        <p
          className="flex items-start gap-2 rounded-card bg-[#fef3c7] px-3 py-2.5 text-[14px] text-text"
          data-testid="hours-leave-consequence"
        >
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 h-4 w-4 shrink-0 text-state-warning"
          />
          <span>{LEAVE_CONSEQUENCE[type]}</span>
        </p>
        <label className="block">
          <span className="mb-1 block text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
            Add a note
          </span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            placeholder="Optional — one line for the office"
            className="h-12 w-full rounded-card border border-border-strong bg-surface px-3 text-[15px] text-text focus:border-brand-navy focus:outline-none"
          />
        </label>
      </div>
    </HoursSheet>
  );
}
