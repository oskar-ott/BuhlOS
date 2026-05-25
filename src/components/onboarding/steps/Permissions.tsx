import { OnboardingShell } from "../OnboardingShell";
import { OnboardingProgress } from "../OnboardingProgress";
import { OnboardingFooter } from "../OnboardingFooter";
import { TOTAL_STEPS } from "../steps";

interface PermissionsStepProps {
  onContinue: () => void;
  onSkip: () => void;
}

const CAMERA_USES: ReadonlyArray<{ title: string; detail: string }> = [
  { title: "Upload site photos", detail: "before / after, evidence" },
  { title: "Scan QR codes", detail: "sign in, gear scan-out" },
  { title: "Capture evidence", detail: "snags, RFIs, defects" },
  { title: "Record as-builts", detail: "what's actually there" },
];

const NOTIF_USES: ReadonlyArray<{ title: string; detail: string }> = [
  { title: "Job updates", detail: "new assignment, schedule change" },
  { title: "Timesheet reminders", detail: "if you forget to log hours" },
  { title: "Gear issues", detail: "T&T expiring, gear flagged" },
];

/**
 * Step 08 · Permissions.
 *
 * Combines the design's camera (screen 09) and notifications (screen 11)
 * explainers into one step. The screen tells the worker what each one
 * is for; the actual iOS / browser permission prompts fire later, on
 * first use — Phil never asks at install time.
 *
 * No live permission requests in this PR — the explainer is honest about
 * "when you tap the camera" and "you can change any of these later in
 * Profile → Notifications" (once the profile surface ships).
 */
export function PermissionsStep({ onContinue, onSkip }: PermissionsStepProps) {
  return (
    <OnboardingShell>
      <OnboardingProgress step={8} total={TOTAL_STEPS} onSkip={onSkip} />

      <div className="px-5 pt-5">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
          Permissions
        </p>
        <h1 className="mt-2 font-display text-[26px] font-bold leading-[1.1] tracking-tight text-text [text-wrap:balance]">
          A couple of things Phil needs to ask.
        </h1>
        <p className="mt-2 text-[15px] leading-snug text-text-muted">
          Both are explained before Phil asks. You can say no — Phil still
          works.
        </p>
      </div>

      <section
        aria-label="Camera"
        className="mt-5 px-5"
      >
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-brand-navy text-base text-text-inverse"
          >
            ◉
          </span>
          <div>
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
              1 of 2
            </p>
            <p className="mt-0.5 font-display text-lg font-bold tracking-tight text-text">
              Camera
            </p>
          </div>
        </div>
        <ul
          aria-label="What Phil uses the camera for"
          className="mt-3 overflow-hidden rounded-[14px] border border-border bg-surface"
        >
          {CAMERA_USES.map((u, i) => (
            <PermItem key={u.title} index={i} title={u.title} detail={u.detail} />
          ))}
        </ul>
      </section>

      <section aria-label="Notifications" className="mt-5 px-5">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-brand-navy text-base text-text-inverse"
          >
            ♪
          </span>
          <div>
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
              2 of 2
            </p>
            <p className="mt-0.5 font-display text-lg font-bold tracking-tight text-text">
              Notifications
            </p>
          </div>
        </div>
        <ul
          aria-label="What Phil will notify you about"
          className="mt-3 overflow-hidden rounded-[14px] border border-border bg-surface"
        >
          {NOTIF_USES.map((u, i) => (
            <PermItem key={u.title} index={i} title={u.title} detail={u.detail} />
          ))}
        </ul>
        <p className="mt-3 font-mono text-[10px] leading-relaxed tracking-wide text-text-muted">
          Phil will ask for these when it needs them — never up front. You can
          change them later from your phone&rsquo;s settings.
        </p>
      </section>

      <OnboardingFooter
        primaryLabel="Sounds good"
        onPrimary={onContinue}
        secondaryLabel="Skip for now"
        onSecondary={onSkip}
      />
    </OnboardingShell>
  );
}

function PermItem({
  index,
  title,
  detail,
}: {
  index: number;
  title: string;
  detail: string;
}) {
  return (
    <li
      className={`flex items-start gap-3 px-3.5 py-3 min-h-[56px] ${
        index === 0 ? "" : "border-t border-border"
      }`}
    >
      <span
        className="mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-emerald-600 font-display text-[12px] font-bold leading-none text-white"
        aria-hidden="true"
      >
        ✓
      </span>
      <div className="flex-1">
        <p className="font-display text-[14.5px] font-semibold tracking-tight text-text">
          {title}
        </p>
        <p className="mt-0.5 text-[12.5px] text-text-muted">{detail}</p>
      </div>
    </li>
  );
}
