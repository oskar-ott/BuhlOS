import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

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
