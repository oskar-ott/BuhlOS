import { OnboardingShell } from "../OnboardingShell";
import { OnboardingFooter } from "../OnboardingFooter";

interface WelcomeStepProps {
  onContinue: () => void;
  onSkipToApp: () => void;
}

/**
 * Step 01 · Welcome.
 *
 * Phil wordmark + a single-sentence pitch. Mirrors design screen 01:
 * a 56×56 yellow wedge with "P", the wordmark "Phil" + "buhlOS · field
 * app" mono caption, then a bold sales line and a soft body line.
 *
 * Two outs:
 *   - Get started → run the flow
 *   - I've used Phil before → straight to /phil/my-day
 */
export function WelcomeStep({ onContinue, onSkipToApp }: WelcomeStepProps) {
  return (
    <OnboardingShell noProgressOffset>
      <div className="flex justify-end px-5 pt-2">
        <button
          type="button"
          onClick={onSkipToApp}
          className="font-display text-[13.5px] font-semibold text-text-muted hover:text-text"
        >
          I&rsquo;ve used Phil before
        </button>
      </div>

      <div className="px-5 pt-16">
        <div className="mb-14 flex items-center gap-3">
          <div
            className="flex h-14 w-14 items-center justify-center rounded-[14px] bg-accent-yellow font-display text-[30px] font-extrabold tracking-tight text-brand-navy"
            aria-hidden="true"
          >
            P
          </div>
          <div>
            <p className="font-display text-[32px] font-extrabold leading-none tracking-tight text-text">
              Phil
            </p>
            <p className="mt-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
              BuhlOS · field app
            </p>
          </div>
        </div>

        <h1 className="mb-3 font-display text-[30px] font-bold leading-[1.12] tracking-tight text-text [text-wrap:balance]">
          Phil helps you log hours, see your gear, and access job info.
        </h1>

        <p className="text-[15px] leading-relaxed text-text-muted">
          Made for site. Built to be quick. Three minutes and you&rsquo;re set.
        </p>
      </div>

      <OnboardingFooter
        primaryLabel="Get started"
        onPrimary={onContinue}
        secondaryLabel="I&rsquo;ve used Phil before"
        onSecondary={onSkipToApp}
      />
    </OnboardingShell>
  );
}
