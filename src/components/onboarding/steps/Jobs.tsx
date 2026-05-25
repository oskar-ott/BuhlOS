import { OnboardingShell } from "../OnboardingShell";
import { OnboardingProgress } from "../OnboardingProgress";
import { OnboardingHeading } from "../OnboardingHeading";
import { OnboardingFooter } from "../OnboardingFooter";
import { TOTAL_STEPS } from "../steps";

interface JobsStepProps {
  onContinue: () => void;
  onSkip: () => void;
}

/**
 * Step 05 · Jobs.
 *
 * Sample job list: one "Today" yellow-tagged primary job + two upcoming
 * cards underneath. Static teach content; the real list lives on
 * /phil/jobs.
 */
export function JobsStep({ onContinue, onSkip }: JobsStepProps) {
  return (
    <OnboardingShell>
      <OnboardingProgress step={5} total={TOTAL_STEPS} onSkip={onSkip} />
      <OnboardingHeading
        eyebrow="Jobs"
        title="Your jobs, in one list."
        sub="Open a job to see everything you need on site."
      />

      <div className="px-5 pt-2">
        <p className="mb-2 font-mono text-[9.5px] font-semibold uppercase tracking-[0.14em] text-text-muted">
          ↓ this is roughly what your list looks like
        </p>

        <article
          aria-label="Sample today's job"
          className="mb-2 flex items-center gap-3 rounded-[14px] border border-border bg-surface px-3.5 py-3.5"
        >
          <div
            className="flex h-[46px] w-[46px] items-center justify-center rounded-[12px] bg-accent-yellow font-display text-[15px] font-extrabold text-brand-navy"
            aria-hidden="true"
          >
            CH
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-1.5">
              <span className="rounded-[3px] bg-accent-yellow px-1.5 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.1em] text-brand-navy">
                Today
              </span>
              <span className="font-mono text-[9.5px] tracking-wide text-text-muted">
                L4 ROUGH-IN
              </span>
            </div>
            <p className="font-display text-base font-bold leading-tight tracking-tight text-text">
              Carlton Hotel · stage 3
            </p>
            <p className="mt-0.5 text-[12.5px] text-text-muted">
              234 Carlton St, Adelaide
            </p>
          </div>
          <span aria-hidden="true" className="text-xl text-text-muted">
            ›
          </span>
        </article>

        {[
          { name: "Norwood depot", stage: "fit-off", when: "Fri" },
          { name: "Plympton clinic", stage: "rough-in", when: "wk 19" },
        ].map((j) => (
          <article
            key={j.name}
            className="mb-2 flex items-center gap-3 rounded-[12px] border border-border bg-surface px-3.5 py-3"
          >
            <div
              className="flex h-[38px] w-[38px] items-center justify-center rounded-[9px] border border-border bg-surface-subtle font-display text-xs font-bold text-text"
              aria-hidden="true"
            >
              {j.name
                .split(" ")
                .map((w) => w[0])
                .slice(0, 2)
                .join("")
                .toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-display text-[14.5px] font-semibold tracking-tight text-text">
                {j.name}
              </p>
              <p className="mt-0.5 font-mono text-[10px] tracking-wide text-text-muted">
                {j.stage}
              </p>
            </div>
            <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.1em] text-text-muted">
              {j.when}
            </span>
          </article>
        ))}

        <p className="mt-1.5 text-[13px] leading-relaxed text-text-muted">
          Don&rsquo;t see a job you&rsquo;re meant to be on?{" "}
          <strong className="font-semibold text-text">
            Ask the office to assign it.
          </strong>
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
