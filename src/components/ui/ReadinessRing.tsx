import { cn } from "@/lib/cn";

/**
 * A compact circular readiness dial (updated Job Builder design). The number is a
 * REAL proportion the caller derives — e.g. ready sections / total sections — not
 * an invented score (P7); it's shown inside the ring while the arc + colour track
 * the readiness tone. Presentational only.
 */

const TONE_TEXT: Record<"danger" | "warning" | "success", string> = {
  danger: "text-state-danger",
  warning: "text-state-warning",
  success: "text-state-success",
};

export function ReadinessRing({
  pct,
  tone,
  label,
  sub,
}: {
  /** 0–100; a real ratio the caller computes, not a fabricated score. */
  pct: number;
  tone: "danger" | "warning" | "success";
  label: string;
  sub?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const r = 16;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - clamped / 100);
  return (
    <div
      className="flex items-center gap-2.5"
      role="img"
      aria-label={`Readiness ${clamped}% — ${label}${sub ? `, ${sub}` : ""}`}
    >
      <div className="relative h-11 w-11 shrink-0">
        <svg viewBox="0 0 40 40" className="h-11 w-11 -rotate-90" aria-hidden="true">
          <circle cx="20" cy="20" r={r} fill="none" strokeWidth="4" stroke="currentColor" className="text-border" />
          <circle
            cx="20"
            cy="20"
            r={r}
            fill="none"
            strokeWidth="4"
            strokeLinecap="round"
            stroke="currentColor"
            className={cn(TONE_TEXT[tone], "transition-[stroke-dashoffset] duration-500")}
            strokeDasharray={circ}
            strokeDashoffset={offset}
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center font-display text-xs font-bold tabular-nums text-text">
          {clamped}
        </span>
      </div>
      <div className="min-w-0 leading-tight">
        <p className="text-sm font-semibold text-text">{label}</p>
        {sub ? <p className="text-xs text-text-muted">{sub}</p> : null}
      </div>
    </div>
  );
}
