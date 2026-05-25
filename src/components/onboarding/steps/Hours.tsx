import { OnboardingShell } from "../OnboardingShell";
import { OnboardingProgress } from "../OnboardingProgress";
import { OnboardingHeading } from "../OnboardingHeading";
import { OnboardingFooter } from "../OnboardingFooter";
import { TOTAL_STEPS } from "../steps";

interface HoursStepProps {
  onContinue: () => void;
  onSkip: () => void;
}

/**
 * Step 03 · How hours work.
 *
 * Shows a sample "Today" hours card that mirrors the real log-hours UI
 * the worker will use on /phil/my-day. No live state — just a static
 * preview that teaches the pattern: tap "Standard day", done.
 */
export function HoursStep({ onContinue, onSkip }: HoursStepProps) {
  return (
    <OnboardingShell>
      <OnboardingProgress step={3} total={TOTAL_STEPS} onSkip={onSkip} />
      <OnboardingHeading
        eyebrow="Hours"
        title="Hours, the short way."
        sub="Tap Standard day. Done. Add a note only if you want to."
      />

      <div className="px-5 pt-2">
        <article
          aria-label="Sample hours card"
          className="rounded-[14px] border border-border bg-surface p-3.5 shadow-card"
        >
          <header className="mb-3 flex items-baseline justify-between">
            <div>
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
                Today
              </p>
              <p className="mt-0.5 font-display text-[19px] font-bold tracking-tight text-text">
                Sample day
              </p>
            </div>
            <p className="font-mono text-[10px] tracking-wide text-text-muted">
              0.0 / 38h wk
            </p>
          </header>

          <button
            type="button"
            disabled
            className="flex w-full cursor-default items-center justify-between rounded-[12px] bg-accent-yellow px-4 py-3 text-brand-navy"
            aria-hidden="true"
          >
            <div className="text-left">
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] opacity-70">
                Tap once
              </p>
              <p className="mt-0.5 font-display text-[18px] font-bold tracking-tight">
                Standard day · 7h 36m
              </p>
            </div>
            <span aria-hidden="true" className="font-display text-xl font-extrabold">
              +
            </span>
          </button>

          <div className="mt-2 flex gap-1.5">
            <span className="flex flex-1 items-center justify-center rounded-[10px] border border-border bg-surface-subtle py-2.5 font-display text-[13px] font-semibold text-text">
              Custom hours
            </span>
            <span className="flex flex-1 items-center justify-center rounded-[10px] border border-border bg-surface-subtle py-2.5 font-display text-[13px] font-semibold text-text">
              + Note
            </span>
          </div>

          <div className="mt-3 flex items-center gap-2.5 rounded-[10px] border border-border bg-surface-subtle px-3 py-2.5">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-[8px] bg-accent-yellow font-display text-[11px] font-extrabold text-brand-navy"
              aria-hidden="true"
            >
              JOB
            </span>
            <div className="flex-1">
              <p className="font-display text-sm font-bold tracking-tight text-text">
                Auto-selected job
              </p>
              <p className="mt-0.5 font-mono text-[10px] tracking-wide text-text-muted">
                Whatever you&rsquo;re on today
              </p>
            </div>
            <span aria-hidden="true" className="text-base text-text-muted">
              ›
            </span>
          </div>

          <footer className="mt-3 flex items-center justify-between border-t border-border pt-2.5">
            <p className="font-mono text-[10px] tracking-wide text-text-muted">
              auto-saved to your sheet
            </p>
            <p className="font-display text-[13px] font-bold text-text">
              Submit hours →
            </p>
          </footer>
        </article>

        <p className="mt-3.5 text-[13px] leading-relaxed text-text-muted">
          <strong className="font-display font-bold text-text">
            No start / finish times.
          </strong>{" "}
          Just hours. The office handles the rest.
        </p>
      </div>

      <OnboardingFooter
        primaryLabel="Got it"
        onPrimary={onContinue}
        secondaryLabel="Show me again later"
        onSecondary={onSkip}
      />
    </OnboardingShell>
  );
}
