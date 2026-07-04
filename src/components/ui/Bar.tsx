import { cn } from "@/lib/cn";

/**
 * Progress / meter bar (prototype `.bar`): a 5px track with a tone-coloured fill.
 *
 * The repo bans inline styles and Tailwind only JIT-generates width classes that
 * appear as LITERALS in source, so the fill snaps to 5% buckets via a static
 * class list rather than a computed `style={{ width }}`.
 */
export type BarTone = "navy" | "success" | "warning" | "danger";

const FILL: Record<BarTone, string> = {
  navy: "bg-brand-navy",
  success: "bg-state-success",
  warning: "bg-state-warning",
  danger: "bg-state-danger",
};

const WIDTHS = [
  "w-0",
  "w-[5%]",
  "w-[10%]",
  "w-[15%]",
  "w-[20%]",
  "w-[25%]",
  "w-[30%]",
  "w-[35%]",
  "w-[40%]",
  "w-[45%]",
  "w-1/2",
  "w-[55%]",
  "w-[60%]",
  "w-[65%]",
  "w-[70%]",
  "w-[75%]",
  "w-[80%]",
  "w-[85%]",
  "w-[90%]",
  "w-[95%]",
  "w-full",
] as const;

function widthClass(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  return WIDTHS[Math.round(clamped / 5)] ?? "w-0";
}

interface BarProps {
  /** 0–100. */
  pct: number;
  tone?: BarTone;
  className?: string;
  "aria-label"?: string;
}

export function Bar({ pct, tone = "navy", className, "aria-label": ariaLabel }: BarProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div
      className={cn("h-[5px] overflow-hidden rounded-pill bg-surface-subtle", className)}
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={ariaLabel}
    >
      <div className={cn("h-full rounded-pill transition-all", FILL[tone], widthClass(clamped))} />
    </div>
  );
}
