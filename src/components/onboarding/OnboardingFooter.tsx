import { cn } from "@/lib/cn";

interface OnboardingFooterProps {
  primaryLabel: string;
  onPrimary: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  primaryVariant?: "yellow" | "navy";
  primaryDisabled?: boolean;
}

/**
 * Sticky bottom action — full-width primary CTA in brand-yellow (the design's
 * "one yellow per screen" rule), optional secondary link underneath.
 *
 * The footer is positioned absolutely against the OnboardingShell flex
 * column so the underlying content can scroll behind the fade gradient
 * without clipping.
 */
export function OnboardingFooter({
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
  primaryVariant = "yellow",
  primaryDisabled = false,
}: OnboardingFooterProps) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 px-5 pb-7 pt-4 [background:linear-gradient(to_top,var(--surface-subtle)_70%,transparent)]">
      <div className="pointer-events-auto space-y-3">
        <button
          type="button"
          onClick={onPrimary}
          disabled={primaryDisabled}
          className={cn(
            "flex h-14 w-full items-center justify-center gap-2 rounded-card font-display text-[15px] font-bold tracking-tight transition-colors",
            primaryVariant === "yellow"
              ? "bg-accent-yellow text-brand-navy hover:brightness-95"
              : "bg-brand-navy text-text-inverse hover:bg-accent-ink",
            primaryDisabled && "cursor-not-allowed opacity-60"
          )}
        >
          <span>{primaryLabel}</span>
          <span aria-hidden="true" className="text-base">
            →
          </span>
        </button>
        {secondaryLabel && onSecondary ? (
          <button
            type="button"
            onClick={onSecondary}
            className="block w-full text-center font-display text-[13.5px] font-semibold text-text underline decoration-border-strong decoration-2 underline-offset-[3px] hover:text-text"
          >
            {secondaryLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}
