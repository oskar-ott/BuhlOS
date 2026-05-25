import { OnboardingShell } from "../OnboardingShell";
import { OnboardingFooter } from "../OnboardingFooter";

interface ReadyStepProps {
  name: string | null;
  onOpenApp: () => void;
  onReview: () => void;
}

const CHECKLIST: ReadonlyArray<string> = [
  "Profile confirmed",
  "Hours ready",
  "Gear visible",
  "Jobs ready",
  "Permissions reviewed",
  "Welcome banner queued",
];

/**
 * Step 09 · Ready / done.
 *
 * Celebration screen with the worker's first name and a six-item checklist.
 * "Open Phil" drops them onto /phil/my-day; "Review setup" goes back to
 * the welcome screen.
 */
export function ReadyStep({ name, onOpenApp, onReview }: ReadyStepProps) {
  const firstName = name?.split(/\s+/)[0] ?? null;
  return (
    <OnboardingShell noProgressOffset>
      <div className="px-5 pt-12">
        <div
          aria-hidden="true"
          className="mb-6 flex h-[60px] w-[60px] items-center justify-center rounded-[16px] bg-accent-yellow font-display text-[32px] font-extrabold text-brand-navy"
        >
          ✓
        </div>

        <h1 className="mb-2 font-display text-[30px] font-bold leading-[1.1] tracking-tight text-text [text-wrap:balance]">
          You&rsquo;re set{firstName ? `, ${firstName}` : ""}.
        </h1>
        <p className="mb-6 text-[15px] leading-relaxed text-text-muted">
          Phil&rsquo;s ready. Site&rsquo;s ready. Let&rsquo;s go.
        </p>

        <ul
          aria-label="Setup checklist"
          className="overflow-hidden rounded-[14px] border border-border bg-surface"
        >
          {CHECKLIST.map((t, i) => (
            <li
              key={t}
              className={`flex items-center gap-3 px-3.5 py-2.5 min-h-[48px] ${
                i === 0 ? "" : "border-t border-border"
              }`}
            >
              <span
                className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-emerald-600 font-display text-[12px] font-extrabold leading-none text-white"
                aria-hidden="true"
              >
                ✓
              </span>
              <span className="flex-1 font-display text-[14.5px] font-semibold tracking-tight text-text">
                {t}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <OnboardingFooter
        primaryLabel="Open Phil"
        onPrimary={onOpenApp}
        secondaryLabel="Review setup"
        onSecondary={onReview}
      />
    </OnboardingShell>
  );
}
