import { OnboardingShell } from "../OnboardingShell";
import { OnboardingProgress } from "../OnboardingProgress";
import { OnboardingHeading } from "../OnboardingHeading";
import { OnboardingFooter } from "../OnboardingFooter";
import { TOTAL_STEPS } from "../steps";

interface JobInterfaceStepProps {
  onContinue: () => void;
  onSkip: () => void;
}

/**
 * Step 06 · Inside a job — preview of the job interface.
 *
 * 2-column grid of feature tiles — LIVE capabilities only. The lean reset
 * (2026-07) reversed the old "label unfinished work under construction"
 * convention: hidden features leave NO trace, so this preview names only
 * what the job screen really offers today (no "soon"/UC tiles, and no tiles
 * for dark features like snags or ITPs).
 */
const TILES: ReadonlyArray<{ name: string; status: "ready" }> = [
  { name: "Address", status: "ready" },
  { name: "Site contact", status: "ready" },
  { name: "Scope", status: "ready" },
  { name: "Plans", status: "ready" },
  { name: "Photos", status: "ready" },
  { name: "Site reqs", status: "ready" },
  { name: "Notes", status: "ready" },
  // #233 — as-built is now live: flag any handover photo or plan markup as
  // as-built, then filter the Photos gallery / plans to that set. It reuses
  // the existing capture + viewer surfaces (no separate as-built flow), so it
  // is genuinely usable end-to-end.
  { name: "As-builts", status: "ready" },
];

export function JobInterfaceStep({ onContinue, onSkip }: JobInterfaceStepProps) {
  return (
    <OnboardingShell>
      <OnboardingProgress step={6} total={TOTAL_STEPS} onSkip={onSkip} />
      <OnboardingHeading
        eyebrow="Inside a job"
        title="Everything you need, on the job screen."
        sub="Site details, plans, photos and your work — one screen per job."
      />

      <div className="px-5 pt-2">
        <div className="grid grid-cols-2 gap-2 rounded-[14px] border border-border bg-surface p-3">
          {TILES.map((t) => (
            <div
              key={t.name}
              className="flex flex-col gap-1.5 rounded-[10px] border border-border bg-surface-subtle px-3 py-3 min-h-[64px]"
            >
              <p className="font-display text-[14px] font-semibold tracking-tight text-text">
                {t.name}
              </p>
              <p className="font-mono text-[12px] font-bold uppercase tracking-[0.1em] text-emerald-700">
                ● ready
              </p>
            </div>
          ))}
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
