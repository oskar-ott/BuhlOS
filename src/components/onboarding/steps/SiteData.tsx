import { OnboardingShell } from "../OnboardingShell";
import { OnboardingProgress } from "../OnboardingProgress";
import { OnboardingHeading } from "../OnboardingHeading";
import { OnboardingFooter } from "../OnboardingFooter";
import { TOTAL_STEPS } from "../steps";

interface SiteDataStepProps {
  onContinue: () => void;
  onSkip: () => void;
}

const ITEMS: ReadonlyArray<{ name: string; detail: string }> = [
  { name: "Photos", detail: "before / after, evidence" },
  { name: "Notes", detail: "what happened, what changed" },
  { name: "Job updates", detail: "progress, ready-for-next-trade" },
  { name: "Snags", detail: "defects, RFIs, blockers" },
  { name: "As-builts", detail: "what's actually installed" },
  { name: "ITPs", detail: "tick off as you go — coming soon" },
];

/**
 * Step 07 · What you'll send back.
 *
 * Quick list of the data types Phil expects from site, with a callout
 * explaining that everything's auto-tagged with job + time + GPS, so
 * paperwork doesn't pile up.
 */
export function SiteDataStep({ onContinue, onSkip }: SiteDataStepProps) {
  return (
    <OnboardingShell>
      <OnboardingProgress step={7} total={TOTAL_STEPS} onSkip={onSkip} />
      <OnboardingHeading
        eyebrow="On site"
        title="What you'll send back."
        sub="This protects you and makes the job record actually useful."
      />

      <div className="px-5 pt-2">
        <ul
          aria-label="What Phil collects"
          className="overflow-hidden rounded-[14px] border border-border bg-surface"
        >
          {ITEMS.map((it, i) => (
            <li
              key={it.name}
              className={`flex items-center gap-3 px-3.5 py-3 min-h-[56px] ${
                i === 0 ? "" : "border-t border-border"
              }`}
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-[2px] bg-accent-yellow"
              />
              <div className="min-w-0 flex-1">
                <p className="font-display text-[14.5px] font-semibold tracking-tight text-text">
                  {it.name}
                </p>
                <p className="mt-0.5 text-[12.5px] text-text-muted">
                  {it.detail}
                </p>
              </div>
            </li>
          ))}
        </ul>

        <p className="mt-3 rounded-[10px] bg-surface-subtle px-3.5 py-3 font-mono text-[10.5px] leading-relaxed tracking-wide text-text-muted">
          Everything you submit is{" "}
          <strong className="font-bold text-text">auto-tagged</strong> with the
          job, time and your GPS location. No paperwork.
        </p>
      </div>

      <OnboardingFooter
        primaryLabel="Next"
        onPrimary={onContinue}
        secondaryLabel="Skip for now"
        onSecondary={onSkip}
      />
    </OnboardingShell>
  );
}
