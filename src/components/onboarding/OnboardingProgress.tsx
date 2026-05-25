import { cn } from "@/lib/cn";

interface OnboardingProgressProps {
  step: number;
  total: number;
  onSkip?: () => void;
  skipLabel?: string;
  skipDisabled?: boolean;
}

/**
 * Thin progress strip with STEP NN · TT label on the left, fill bar in the
 * middle and an optional Skip link on the right.
 *
 * Width is selected from a discrete class map (no inline style — per the
 * ESLint no-restricted-syntax rule against the `style` attribute). The
 * design has 8 numbered steps, so widths 12.5% / 25% / 37.5% / 50% /
 * 62.5% / 75% / 87.5% / 100% are all the values that ever render here.
 */
const FILL_WIDTHS: Record<number, string> = {
  0: "w-0",
  1: "w-[12.5%]",
  2: "w-1/4",
  3: "w-[37.5%]",
  4: "w-1/2",
  5: "w-[62.5%]",
  6: "w-3/4",
  7: "w-[87.5%]",
  8: "w-full",
};

export function OnboardingProgress({
  step,
  total,
  onSkip,
  skipLabel = "Skip",
  skipDisabled = false,
}: OnboardingProgressProps) {
  const clamped = Math.max(0, Math.min(total, Math.round(step)));
  const fillClass =
    total === 8 ? FILL_WIDTHS[clamped] : pickGenericFill(clamped, total);
  return (
    <div className="flex items-center gap-3 px-5 pt-12">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
        Step {String(step).padStart(2, "0")} · {String(total).padStart(2, "0")}
      </span>
      <div
        className="flex h-[2px] flex-1 overflow-hidden rounded-full bg-border"
        role="progressbar"
        aria-valuenow={step}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={`Onboarding progress: step ${step} of ${total}`}
      >
        <span
          aria-hidden="true"
          className={cn("h-full bg-accent-yellow transition-[width]", fillClass)}
        />
      </div>
      {onSkip ? (
        <button
          type="button"
          onClick={onSkip}
          disabled={skipDisabled}
          className={cn(
            "font-display text-xs font-semibold tracking-tight",
            skipDisabled
              ? "cursor-not-allowed text-text-muted/40"
              : "text-text-muted hover:text-text"
          )}
        >
          {skipLabel}
        </button>
      ) : (
        <span className="w-9" aria-hidden="true" />
      )}
    </div>
  );
}

/**
 * Fallback for non-default totals; rounds to the nearest 10% bucket so
 * Tailwind can still resolve the class statically.
 */
function pickGenericFill(step: number, total: number): string {
  if (total <= 0) return "w-0";
  const pct = (step / total) * 100;
  if (pct <= 0) return "w-0";
  if (pct >= 100) return "w-full";
  const bucket = Math.round(pct / 10) * 10;
  switch (bucket) {
    case 10:
      return "w-[10%]";
    case 20:
      return "w-1/5";
    case 30:
      return "w-[30%]";
    case 40:
      return "w-2/5";
    case 50:
      return "w-1/2";
    case 60:
      return "w-3/5";
    case 70:
      return "w-[70%]";
    case 80:
      return "w-4/5";
    case 90:
      return "w-[90%]";
    default:
      return "w-1/2";
  }
}
