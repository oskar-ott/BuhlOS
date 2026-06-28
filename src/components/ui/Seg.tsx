"use client";

import { cn } from "@/lib/cn";

/**
 * Segmented control (prototype `.seg`): the filter/toggle row used across the
 * inboxes, the job portfolio and the hours screen. Each option can carry a live
 * count chip. Controlled — the parent owns the active value.
 */
export interface SegOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

interface SegProps<T extends string> {
  options: ReadonlyArray<SegOption<T>>;
  value: T;
  onChange: (value: T) => void;
  "aria-label"?: string;
  className?: string;
}

export function Seg<T extends string>({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
  className,
}: SegProps<T>) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex flex-wrap gap-1 rounded-card border border-border bg-surface p-1",
        className
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-card px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-brand-navy text-text-inverse"
                : "text-text-muted hover:bg-surface-subtle hover:text-text"
            )}
          >
            <span>{o.label}</span>
            {o.count !== undefined ? (
              <span
                className={cn(
                  "rounded-pill px-1.5 font-mono text-[10px] font-semibold tabular-nums",
                  active ? "bg-white/20 text-text-inverse" : "bg-surface-subtle text-text-muted"
                )}
              >
                {o.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
