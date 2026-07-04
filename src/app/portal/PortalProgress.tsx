import { cn } from "@/lib/cn";
import type { PortalJob } from "@/domains/client-portal/schema";

/**
 * The overall-progress bar shown on portal cards and the job page.
 *
 * Honest about "no number yet" (P7): when progressPct is null the job has no
 * checklist, so we render a "Not started" state with an empty track — never a
 * fake 0% that looks like measured-but-nothing-done.
 *
 * The fill width is a STATIC Tailwind class bucketed to the nearest 5% (no
 * inline style — the rebuild non-negotiables ban inline styles; see
 * OnboardingProgress / WeeklyHoursCloseoutBoard for the same pattern). 5%
 * buckets are visually indistinguishable from the exact number on a phone-width
 * bar; the exact % is always shown as text alongside.
 */

// Static width classes so Tailwind sees every literal at build time.
const FILL_WIDTH: Record<number, string> = {
  0: "w-0",
  5: "w-[5%]",
  10: "w-[10%]",
  15: "w-[15%]",
  20: "w-[20%]",
  25: "w-[25%]",
  30: "w-[30%]",
  35: "w-[35%]",
  40: "w-[40%]",
  45: "w-[45%]",
  50: "w-[50%]",
  55: "w-[55%]",
  60: "w-[60%]",
  65: "w-[65%]",
  70: "w-[70%]",
  75: "w-[75%]",
  80: "w-[80%]",
  85: "w-[85%]",
  90: "w-[90%]",
  95: "w-[95%]",
  100: "w-full",
};

function fillClassFor(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const bucket = Math.round(clamped / 5) * 5;
  return FILL_WIDTH[bucket] ?? "w-0";
}

export function PortalProgress({
  progressPct,
  stageLabel,
}: {
  progressPct: PortalJob["progressPct"];
  stageLabel: string;
}) {
  const known = typeof progressPct === "number";
  const pct = known ? Math.max(0, Math.min(100, progressPct)) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-text">{stageLabel}</span>
        <span className="tabular-nums text-text-muted">{known ? `${pct}%` : "—"}</span>
      </div>
      <div
        className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-surface-subtle"
        role="progressbar"
        aria-valuenow={known ? pct : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Overall progress"
      >
        <div
          className={cn(
            "h-full rounded-full bg-brand-navy transition-[width]",
            known ? fillClassFor(pct) : "w-0",
          )}
        />
      </div>
    </div>
  );
}
