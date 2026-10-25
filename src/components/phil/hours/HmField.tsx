"use client";

import { useId, type ReactNode } from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Hours + minutes, never a decimal and never a whole-hour grid — the one
 * duration input on the Hours screen. Two number fields with steppers
 * (−1h/+1h on the hours, −5m/+5m or −15m/+15m on the minutes). The value is a
 * single minutes count so the pair is always a legal clock reading.
 */
export function HmField({
  label,
  minutes,
  onChange,
  minuteStep = 5,
  maxMinutes,
  hoursLabel = "hours",
  minutesLabel = "minutes",
  testId,
}: {
  label: string;
  minutes: number;
  onChange: (minutes: number) => void;
  minuteStep?: 5 | 15;
  /** Hard ceiling — the steppers stop here; typing past it is clamped. */
  maxMinutes: number;
  hoursLabel?: string;
  minutesLabel?: string;
  testId?: string;
}): ReactNode {
  const id = useId();
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const clamp = (n: number) => Math.max(0, Math.min(maxMinutes, Math.round(n)));
  const setH = (nextH: number) => onChange(clamp(Math.max(0, nextH) * 60 + m));
  const setM = (nextM: number) => onChange(clamp(h * 60 + Math.max(0, Math.min(59, nextM))));

  const field =
    "h-12 w-full min-w-0 rounded-card border border-border-strong bg-surface px-2 text-center font-display text-[20px] font-bold tabular-nums text-text focus:border-brand-navy focus:outline-none";
  const step =
    "inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-card border border-border-strong bg-surface text-text active:bg-surface-subtle disabled:opacity-40";

  return (
    <fieldset className="min-w-0" data-testid={testId}>
      <legend className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-text-muted">
        {label}
      </legend>
      <div className="grid grid-cols-2 gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setH(h - 1)}
              disabled={h <= 0}
              aria-label={`Take 1 hour off ${hoursLabel}`}
              className={step}
            >
              <Minus aria-hidden="true" className="h-5 w-5" />
            </button>
            <label htmlFor={`${id}-h`} className="sr-only">
              {label}: {hoursLabel}
            </label>
            <input
              id={`${id}-h`}
              type="number"
              inputMode="numeric"
              min={0}
              max={Math.floor(maxMinutes / 60)}
              step={1}
              value={h}
              onChange={(e) => setH(Number(e.target.value) || 0)}
              className={field}
            />
            <button
              type="button"
              onClick={() => setH(h + 1)}
              disabled={(h + 1) * 60 + m > maxMinutes}
              aria-label={`Add 1 hour to ${hoursLabel}`}
              className={step}
            >
              <Plus aria-hidden="true" className="h-5 w-5" />
            </button>
          </div>
          <p className="mt-1 text-center text-[13px] text-text-muted">h · −1h / +1h</p>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setM(m - minuteStep)}
              disabled={minutes <= 0}
              aria-label={`Take ${minuteStep} minutes off ${minutesLabel}`}
              className={step}
            >
              <Minus aria-hidden="true" className="h-5 w-5" />
            </button>
            <label htmlFor={`${id}-m`} className="sr-only">
              {label}: {minutesLabel}
            </label>
            <input
              id={`${id}-m`}
              type="number"
              inputMode="numeric"
              min={0}
              max={59}
              step={minuteStep}
              value={m}
              onChange={(e) => setM(Number(e.target.value) || 0)}
              className={cn(field)}
            />
            <button
              type="button"
              onClick={() => setM(m + minuteStep)}
              disabled={minutes + minuteStep > maxMinutes || m + minuteStep > 59}
              aria-label={`Add ${minuteStep} minutes to ${minutesLabel}`}
              className={step}
            >
              <Plus aria-hidden="true" className="h-5 w-5" />
            </button>
          </div>
          <p className="mt-1 text-center text-[13px] text-text-muted">
            m · −{minuteStep}m / +{minuteStep}m
          </p>
        </div>
      </div>
    </fieldset>
  );
}
