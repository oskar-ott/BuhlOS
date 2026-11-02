"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowDown, Camera, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { ItpBadge, ItpPrimaryButton, ItpSecondaryButton } from "./ItpControls";
import styles from "./itp.module.css";

/**
 * How ITPs work (boards 9–10): four screens, one idea each. Skip top right
 * (44px), Back / Next 64px, last step Got it + "Find this again in Settings
 * → Help." Swipe left/right also moves steps; the buttons always work
 * (P12). Shown once per person from the ITP list (never on the builder),
 * and any time from Settings → Help.
 */
const STEPS: ReadonlyArray<{ title: string; body: string; art: ReactNode; alt: string }> = [
  {
    title: "Tap a name, take photos",
    body: "Pick a recent name or say one. In a hurry? Take photos now and name the area later.",
    alt: "Name chips with Kitchen highlighted, then the camera",
    art: (
      <>
        <div className="flex flex-wrap justify-center gap-2">
          {["Switchboard", "Kitchen", "Meter box"].map((n) => (
            <span
              key={n}
              className={cn(
                "inline-flex min-h-[44px] items-center rounded-pill border border-border-strong bg-surface px-4 text-[16px] font-semibold",
                n === "Kitchen" && "ring-4 ring-accent-yellow"
              )}
            >
              {n}
            </span>
          ))}
        </div>
        <ArrowDown aria-hidden="true" className="h-7 w-7 text-text-muted" />
        <span className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-brand-navy text-accent-yellow">
          <Camera aria-hidden="true" className="h-9 w-9" />
        </span>
      </>
    ),
  },
  {
    title: "Back to any area in one tap",
    body: "Every area has its own Photos button. Tap an area's name to add from the camera roll, rename or remove it.",
    alt: "Two area cards, the Switchboard Photos button highlighted",
    art: (
      <div className="w-full space-y-2">
        {[
          { name: "Switchboard", hl: true, n: 4 },
          { name: "Kitchen ›", hl: false, n: 3 },
        ].map((a) => (
          <div key={a.name} className="rounded-card border border-border bg-surface p-3">
            <div className="flex items-center justify-between">
              <span className="text-[17px] font-bold">{a.name}</span>
              <span
                className={cn(
                  "inline-flex min-h-[40px] items-center gap-1.5 rounded-[10px] border-2 border-brand-navy px-2.5 text-[15px] font-bold text-brand-navy",
                  a.hl && "ring-4 ring-accent-yellow"
                )}
              >
                <Camera aria-hidden="true" className="h-4 w-4" />
                Photos
              </span>
            </div>
            <div className="mt-2 grid grid-cols-4 gap-1.5">
              {Array.from({ length: a.n }).map((_, i) => (
                <span key={i} className="aspect-square rounded-[6px] bg-state-neutral-dot" />
              ))}
            </div>
          </div>
        ))}
      </div>
    ),
  },
  {
    title: "Watch the tiles",
    body: "Each photo shows if it's saving. Red means it didn't — tap Retry. Stay on this screen till they're done.",
    alt: "Three photo tiles: saving, didn't save with Retry, and saved",
    art: (
      <div className="grid w-full grid-cols-3 gap-3 text-[15px] font-bold">
        <div className="flex flex-col items-center gap-2">
          <div className="relative aspect-square w-full overflow-hidden rounded-[8px] bg-state-neutral-dot">
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-[rgba(246,247,249,0.82)] text-[14px] text-state-info">
              <Loader2 aria-hidden="true" className={cn("h-5 w-5", styles.spin)} />
              Saving
            </div>
          </div>
          <span className="text-state-info">On its way</span>
        </div>
        <div className="flex flex-col items-center gap-2">
          <div className="relative aspect-square w-full overflow-hidden rounded-[8px] bg-state-neutral-dot ring-[3px] ring-inset ring-state-danger">
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-[rgba(253,236,236,0.94)] text-[14px] text-state-danger-subtle-text">
              Didn&rsquo;t save
              <span className="rounded-[6px] bg-state-danger px-2 py-1 text-[13px] text-text-inverse">
                Retry
              </span>
            </div>
          </div>
          <span className="text-state-danger-subtle-text">Tap Retry</span>
        </div>
        <div className="flex flex-col items-center gap-2">
          <div className="aspect-square w-full rounded-[8px] bg-state-neutral-dot" />
          <span>Saved</span>
        </div>
      </div>
    ),
  },
  {
    title: "Make the PDF, send it",
    body: "All areas or just some. Then send it to the office, email it, or save it. Amber means photos changed — make it again.",
    alt: "The bottom bar's three PDF states",
    art: (
      <div className="w-full space-y-2">
        {[
          { badge: "No PDF yet", tone: "neutral" as const, action: "Make the PDF" },
          { badge: "Sent to office", tone: "success" as const, action: "PDFs · 2" },
          { badge: "PDF out of date", tone: "warning" as const, action: "PDFs · 2" },
        ].map((r) => (
          <div
            key={r.badge}
            className="flex min-h-[52px] items-center justify-between rounded-card border border-border-strong bg-surface px-3 py-2"
          >
            <ItpBadge tone={r.tone}>{r.badge}</ItpBadge>
            <span className="rounded-[8px] border-2 border-brand-navy px-2.5 py-1 text-[14px] font-bold text-brand-navy">
              {r.action}
            </span>
          </div>
        ))}
      </div>
    ),
  },
];

export function PhilItpWalkthrough({
  open,
  onSkip,
  onDone,
}: {
  open: boolean;
  onSkip: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState<"fwd" | "back">("fwd");
  const titleId = useId();
  const startX = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      setStep(0);
      setDir("fwd");
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onSkip();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onSkip]);

  if (!open) return null;
  const last = step === STEPS.length - 1;
  const s = STEPS[step]!;

  function go(next: number) {
    if (next < 0 || next >= STEPS.length) return;
    setDir(next > step ? "fwd" : "back");
    setStep(next);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="itp-walkthrough"
      className="fixed inset-0 z-[80] flex flex-col bg-surface text-text"
      onTouchStart={(e) => {
        startX.current = e.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(e) => {
        const start = startX.current;
        const end = e.changedTouches[0]?.clientX;
        startX.current = null;
        if (start == null || end == null) return;
        if (end - start < -60) go(step + 1);
        else if (end - start > 60) go(step - 1);
      }}
    >
      <div className="flex h-14 shrink-0 items-center justify-between bg-brand-navy pl-4 pr-1 text-text-inverse">
        <span className="font-display text-[17px] font-bold">How ITPs work</span>
        <button
          type="button"
          onClick={onSkip}
          className="min-h-[44px] px-3 font-display text-[16px] font-bold text-accent-yellow focus-visible:outline-accent-yellow"
        >
          Skip
        </button>
      </div>

      <div
        key={step}
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pb-7 pt-5",
          dir === "fwd" ? styles.stepIn : styles.stepInBack
        )}
      >
        <div
          role="img"
          aria-label={s.alt}
          className="flex min-h-[260px] shrink-0 flex-col items-center justify-center gap-3.5 rounded-[16px] border border-border bg-surface-subtle p-4"
        >
          {s.art}
        </div>
        <h2 id={titleId} className="font-display text-[28px] font-extrabold leading-[34px]">
          {s.title}
        </h2>
        <p className="text-[18px] leading-[27px] text-text">{s.body}</p>

        <div className="mt-auto space-y-3">
          <div className="flex items-center justify-center gap-2 text-[15px] font-semibold text-text-muted">
            {STEPS.map((_, i) => (
              <span
                key={i}
                aria-hidden="true"
                className={cn(
                  "h-2.5 rounded-full",
                  i === step ? "w-6 bg-brand-navy" : "w-2.5 bg-border-strong"
                )}
              />
            ))}
            <span className="ml-1.5">{`${step + 1} of ${STEPS.length}`}</span>
          </div>
          <div className="flex gap-2.5">
            {step > 0 ? (
              <ItpSecondaryButton
                onClick={() => go(step - 1)}
                className="w-[34%] shrink-0 min-h-[64px]"
              >
                Back
              </ItpSecondaryButton>
            ) : null}
            {last ? (
              <ItpPrimaryButton onClick={onDone}>Got it</ItpPrimaryButton>
            ) : (
              <ItpPrimaryButton onClick={() => go(step + 1)}>Next</ItpPrimaryButton>
            )}
          </div>
          {last ? (
            <p className="text-center text-[15px] font-semibold text-text-muted">
              Find this again in Settings → Help.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Per-person, per-phone memory of the walkthrough (handoff "Walkthrough"
 *  rules 3): "seen" once synced, "seen-unsynced" while the server hasn't
 *  been told yet (no signal at Skip). */
export function walkthroughLocalKey(userId: string): string {
  return `phil.itp.walkthrough.${userId || "anon"}`;
}
