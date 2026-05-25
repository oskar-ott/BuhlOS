import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Status pills use the five-tone palette from doc 27 §6.1:
 *   - success (approved · reviewed · returned · assigned · complete · good)
 *   - info    (submitted · in_progress · captured · pending_sync · saved)
 *   - warning (on_hold · needs_info · pending_review · maintenance)
 *   - danger  (rejected · failed · lost · damaged · missing · wont_fix)
 *   - neutral (draft · archived · pending · UC · empty)
 *
 * The `yellow` and `navy` tones are brand accents (not status). Use them
 * for selection indicators, in-card chip labels, or "UC" markers — never
 * to express the state of a TimesheetEntry / GearAsset / Job / Evidence /
 * Snag. Mixing brand accents with the status palette breaks the worker's
 * one-glance scan ("rejected" must always read danger-red, never navy).
 */
type Tone = "neutral" | "yellow" | "navy" | "success" | "danger" | "info" | "warning";

interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  children: ReactNode;
}

const TONE_CLASSES: Record<Tone, string> = {
  neutral: "bg-surface-subtle text-text border border-border",
  yellow: "bg-accent-yellow text-brand-navy border border-accent-yellow",
  navy: "bg-brand-navy text-text-inverse border border-brand-navy",
  success: "bg-emerald-50 text-emerald-800 border border-emerald-200",
  danger: "bg-rose-50 text-rose-800 border border-rose-200",
  info: "bg-sky-50 text-sky-800 border border-sky-200",
  warning: "bg-amber-50 text-amber-900 border border-amber-200",
};

export function Pill({ tone = "neutral", className, children, ...rest }: PillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 text-xs font-medium",
        TONE_CLASSES[tone],
        className
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
