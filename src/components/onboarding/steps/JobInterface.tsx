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
 * 2-column grid of feature tiles. Each tile is either "ready" (live) or
 * "under construction" (shipping later). This sets the expectation that
 * the tab is visible even when the feature isn't ready, per the
 * non-negotiable rule: never hide unfinished features — label them.
 */
const TILES: ReadonlyArray<{ name: string; status: "ready" | "soon" }> = [
  { name: "Address", status: "ready" },
  { name: "Site contact", status: "ready" },
  { name: "Scope", status: "ready" },
  { name: "Plans", status: "ready" },
  { name: "Photos", status: "ready" },
  { name: "Snags", status: "ready" },
  { name: "Site reqs", status: "ready" },
  { name: "Notes", status: "ready" },
  { name: "ITPs", status: "soon" },
  { name: "As-builts", status: "soon" },
];

export function JobInterfaceStep({ onContinue, onSkip }: JobInterfaceStepProps) {
  return (
    <OnboardingShell>
      <OnboardingProgress step={6} total={TOTAL_STEPS} onSkip={onSkip} />
      <OnboardingHeading
        eyebrow="Inside a job"
        title="Everything you need, on the job screen."
        sub="Anything not ready yet shows as &ldquo;under construction&rdquo; — never hidden."
      />

      <div className="px-5 pt-2">
        <div className="grid grid-cols-2 gap-2 rounded-[14px] border border-border bg-surface p-3">
          {TILES.map((t) => (
            <div
              key={t.name}
              className="flex flex-col gap-1.5 rounded-[10px] border border-border bg-surface-subtle px-3 py-3 min-h-[64px]"
            >
              <p
                className={`font-display text-[14px] font-semibold tracking-tight ${
                  t.status === "soon" ? "text-text-muted" : "text-text"
                }`}
              >
                {t.name}
              </p>
              <p
                className={`font-mono text-[9px] font-bold uppercase tracking-[0.1em] ${
                  t.status === "soon" ? "text-amber-700" : "text-emerald-700"
                }`}
              >
                {t.status === "soon" ? "◔ under construction" : "● ready"}
              </p>
            </div>
          ))}
        </div>

        <aside className="mt-3 flex items-start gap-2.5 rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-3">
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-amber-500 font-display text-sm font-extrabold text-white"
            aria-hidden="true"
          >
            ◔
          </span>
          <p className="text-[13px] leading-snug text-amber-900">
            <strong className="block text-text">
              &ldquo;Under construction&rdquo; means: ship-it-later.
            </strong>
            The tab&rsquo;s there. The feature isn&rsquo;t. Keep using the rest as
            normal.
          </p>
        </aside>
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
