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
  /** Render the tone's solid status dot before the label (status pills in the
   *  Job Detail Variants language). Ignored for the brand tones. */
  dot?: boolean;
  children: ReactNode;
}

/** Status tones ride the state-* quads from tokens.css (Job Detail Variants
 *  2f — no more hardcoded emerald/rose literals); brand tones are unchanged. */
const TONE_CLASSES: Record<Tone, string> = {
  neutral:
    "bg-state-neutral-subtle-bg text-state-neutral-subtle-text border border-state-neutral-subtle-border",
  yellow: "bg-accent-yellow text-brand-navy border border-accent-yellow",
  navy: "bg-brand-navy text-text-inverse border border-brand-navy",
  success:
    "bg-state-success-subtle-bg text-state-success-subtle-text border border-state-success-subtle-border",
  danger:
    "bg-state-danger-subtle-bg text-state-danger-subtle-text border border-state-danger-subtle-border",
  info: "bg-state-info-subtle-bg text-state-info-subtle-text border border-state-info-subtle-border",
  warning:
    "bg-state-warning-subtle-bg text-state-warning-subtle-text border border-state-warning-subtle-border",
};

const DOT_CLASSES: Partial<Record<Tone, string>> = {
  neutral: "bg-state-neutral-dot",
  success: "bg-state-success-dot",
  danger: "bg-state-danger-dot",
  info: "bg-state-info-dot",
  warning: "bg-state-warning-dot",
};

export function Pill({ tone = "neutral", dot, className, children, ...rest }: PillProps) {
  const dotClass = dot ? DOT_CLASSES[tone] : undefined;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill px-2.5 py-0.5 text-xs font-semibold",
        TONE_CLASSES[tone],
        className
      )}
      {...rest}
    >
      {dotClass ? (
        <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-pill", dotClass)} />
      ) : null}
      {children}
    </span>
  );
}
