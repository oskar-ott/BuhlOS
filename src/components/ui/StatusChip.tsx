import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * One shared status marker for both surfaces.
 *
 * Per the Interface Bible vNext §07 "marker laws":
 *   - Status uses a chip (dot + label), never grey body text.
 *   - Wording is fixed across both surfaces ("Submitted" not "Pending review").
 *   - Colour means something — green/success, amber/warning, red/danger,
 *     navy/info-or-active, neutral for inert, yellow for the brand accent
 *     (decorative / "live now" only).
 *
 * Existing per-domain helpers in `src/domains/<x>/format.ts` already return
 * a semantic tone — feed it straight to <StatusChip tone={statusTone(x)}>.
 */
export type StatusTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "navy"
  | "yellow";

interface StatusChipProps extends HTMLAttributes<HTMLSpanElement> {
  /** Semantic tone — drives colour. */
  tone?: StatusTone;
  /** Show the leading status dot (default true). Set false for inline labels. */
  dot?: boolean;
  /** Render with uppercase mono "instrument" voice (default true). */
  uppercase?: boolean;
  children: ReactNode;
}

const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: "bg-surface-subtle text-text border-border",
  info: "bg-sky-50 text-sky-800 border-sky-200",
  success: "bg-emerald-50 text-emerald-800 border-emerald-200",
  warning: "bg-amber-50 text-amber-900 border-amber-200",
  danger: "bg-rose-50 text-rose-800 border-rose-200",
  navy: "bg-brand-navy text-text-inverse border-brand-navy",
  yellow: "bg-accent-yellow text-brand-navy border-accent-yellow",
};

const DOT_CLASSES: Record<StatusTone, string> = {
  neutral: "bg-text-muted",
  info: "bg-sky-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-rose-500",
  navy: "bg-accent-yellow",
  yellow: "bg-brand-navy",
};

export function StatusChip({
  tone = "neutral",
  dot = true,
  uppercase = true,
  className,
  children,
  ...rest
}: StatusChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill border px-2 py-0.5 font-mono text-[10.5px] font-semibold tracking-wider",
        uppercase ? "uppercase" : "normal-case",
        TONE_CLASSES[tone],
        className
      )}
      {...rest}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT_CLASSES[tone])}
        />
      ) : null}
      <span>{children}</span>
    </span>
  );
}
