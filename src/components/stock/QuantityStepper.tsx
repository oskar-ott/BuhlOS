"use client";

import { useEffect, useId, useState } from "react";
import { Lock } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatNumber, parseTypedQuantity, UNIT_LABEL } from "@/domains/workshop-stock/format";
import { inputModeFor, stepQuantity } from "@/domains/workshop-stock/flow";
import type { StockUnit } from "@/domains/workshop-stock/schema";

/**
 * Big −/+ quantity control with direct entry (Workshop Stock).
 *
 * 56px gloved-thumb targets (P8), the number the largest thing on the screen,
 * the unit always beside it, the numeric keypad for whole units and the
 * decimal one for metres. Typing is parsed exactly (no floats) and an
 * unparseable entry says so instead of silently snapping. `unitLabel`
 * overrides the unit text — e.g. "boxes" when the worker is counting packs.
 * `lockedNote` names why the control is off ("Locked so it can't record twice").
 */
export function QuantityStepper({
  label,
  valueMilli,
  onChange,
  unit,
  unitLabel,
  min = 0,
  allowZero = false,
  disabled = false,
  lockedNote,
  invalid: invalidOutside = false,
  testId,
}: {
  label: string;
  valueMilli: number;
  onChange: (milli: number) => void;
  unit: StockUnit;
  unitLabel?: string;
  min?: number;
  allowZero?: boolean;
  disabled?: boolean;
  lockedNote?: string | null;
  /** the number is refused for a reason shown elsewhere (more than is recorded) */
  invalid?: boolean;
  testId?: string;
}) {
  const id = useId();
  const [text, setText] = useState(formatNumber(valueMilli));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setText(formatNumber(valueMilli));
    setInvalid(false);
  }, [valueMilli]);

  const unitText = unitLabel ?? (valueMilli === 1000 ? UNIT_LABEL[unit].singular : UNIT_LABEL[unit].plural);
  const floor = allowZero ? 0 : Math.max(min, unit === "metre" ? 100 : 1000);

  function commit(next: string) {
    setText(next);
    const milli = parseTypedQuantity(next, unit, { allowZero });
    if (milli === null || milli < min) {
      setInvalid(next.trim() !== "");
      return;
    }
    setInvalid(false);
    onChange(milli);
  }

  const side = "inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-[14px] border-2 border-brand-navy bg-surface font-display text-[28px] font-bold leading-none text-brand-navy hover:bg-surface-subtle disabled:border-border-strong disabled:text-text-muted disabled:opacity-60";

  return (
    <div className="space-y-1.5" data-testid={testId}>
      <label htmlFor={id} className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-text">
        {label}
        {disabled && lockedNote ? (
          <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-text-muted">
            <Lock aria-hidden="true" className="h-3.5 w-3.5" /> {lockedNote}
          </span>
        ) : null}
      </label>
      <div className="flex items-stretch gap-2.5">
        <button type="button" aria-label={`One less ${UNIT_LABEL[unit].singular}`} disabled={disabled || valueMilli <= floor} onClick={() => onChange(stepQuantity(valueMilli, unit, -1, floor))} className={side} data-testid={testId ? `${testId}-minus` : undefined}>
          −
        </button>
        <div className={cn("flex h-14 min-w-0 flex-1 items-center rounded-[14px] border-2 bg-surface px-3", invalid || invalidOutside ? "border-state-danger" : "border-border-strong")}>
          <input
            id={id}
            type="text"
            inputMode={inputModeFor(unit)}
            autoComplete="off"
            value={text}
            disabled={disabled}
            onChange={(e) => commit(e.target.value)}
            onBlur={() => { if (invalid || text.trim() === "") { setText(formatNumber(valueMilli)); setInvalid(false); } }}
            aria-invalid={invalid || invalidOutside}
            aria-describedby={invalid ? `${id}-hint` : undefined}
            className={cn("h-14 w-full min-w-0 bg-transparent text-center font-display text-[30px] font-extrabold tabular-nums outline-none", disabled ? "text-text-muted" : "text-text")}
            data-testid={testId ? `${testId}-input` : undefined}
          />
          <span className="shrink-0 pl-1.5 text-[17px] font-semibold text-text-muted">{unitText}</span>
        </div>
        <button type="button" aria-label={`One more ${UNIT_LABEL[unit].singular}`} disabled={disabled} onClick={() => onChange(stepQuantity(valueMilli, unit, 1, floor))} className={side} data-testid={testId ? `${testId}-plus` : undefined}>
          +
        </button>
      </div>
      {invalid ? (
        <p id={`${id}-hint`} className="text-xs text-state-danger" role="status">
          {UNIT_LABEL[unit].decimals > 0 ? "Use a number like 12 or 12.5." : "Use a whole number."}
        </p>
      ) : null}
    </div>
  );
}
