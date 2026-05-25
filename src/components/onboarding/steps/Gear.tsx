import { OnboardingShell } from "../OnboardingShell";
import { OnboardingProgress } from "../OnboardingProgress";
import { OnboardingHeading } from "../OnboardingHeading";
import { OnboardingFooter } from "../OnboardingFooter";
import { TOTAL_STEPS } from "../steps";

interface GearStepProps {
  onContinue: () => void;
  onSkip: () => void;
}

const SAMPLE_GEAR: ReadonlyArray<{ name: string; meta: string; initials: string }> = [
  { name: "Keys", meta: "site · van · workshop", initials: "K" },
  { name: "Passes", meta: "white card · induction", initials: "P" },
  { name: "Tools", meta: "Hilti SDS · Megger", initials: "T" },
  { name: "Van #4", meta: "rego SB12-AY", initials: "V" },
  { name: "Test equipment", meta: "MFT · earth tester", initials: "M" },
];

/**
 * Step 04 · My Gear.
 *
 * Sample list of what Phil's gear screen looks like. Each row gets a
 * small "ok" pill. Two soft buttons underneath: report missing / damaged.
 * No live data — this is purely a teach screen.
 */
export function GearStep({ onContinue, onSkip }: GearStepProps) {
  return (
    <OnboardingShell>
      <OnboardingProgress step={4} total={TOTAL_STEPS} onSkip={onSkip} />
      <OnboardingHeading
        eyebrow="My Gear"
        title="Your gear, on you."
        sub="Phil tracks what's signed out to your name. Flag anything missing or busted."
      />

      <div className="px-5 pt-2">
        <ul
          aria-label="Sample gear"
          className="overflow-hidden rounded-[14px] border border-border bg-surface"
        >
          {SAMPLE_GEAR.map((g, i) => (
            <li
              key={g.name}
              className={`flex items-center gap-3 px-3.5 py-2.5 min-h-[56px] ${
                i === 0 ? "" : "border-t border-border"
              }`}
            >
              <span
                className="flex h-9 w-9 items-center justify-center rounded-[9px] border border-border bg-surface-subtle font-display text-[13px] font-extrabold text-text"
                aria-hidden="true"
              >
                {g.initials}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-display text-[14.5px] font-semibold tracking-tight text-text">
                  {g.name}
                </p>
                <p className="mt-0.5 truncate font-mono text-[10px] tracking-wide text-text-muted">
                  {g.meta}
                </p>
              </div>
              <span className="shrink-0 whitespace-nowrap rounded-[3px] bg-emerald-50 px-1.5 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.1em] text-emerald-800">
                OK
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-[12px] border border-border bg-surface px-3 py-2.5 min-h-[56px]">
            <p className="font-display text-sm font-bold tracking-tight text-text">
              Report missing
            </p>
            <p className="mt-0.5 font-mono text-[9.5px] tracking-wide text-text-muted">
              can&rsquo;t find it
            </p>
          </div>
          <div className="rounded-[12px] border border-border bg-surface px-3 py-2.5 min-h-[56px]">
            <p className="font-display text-sm font-bold tracking-tight text-text">
              Report damaged
            </p>
            <p className="mt-0.5 font-mono text-[9.5px] tracking-wide text-text-muted">
              broken / needs T&amp;T
            </p>
          </div>
        </div>
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
