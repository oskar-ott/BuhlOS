"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import styles from "./itp.module.css";

/**
 * The last block in a sheet, under a divider (handoff 2026-11-02 "Danger
 * zone"): label + consequence. First tap arms (red fill, "Tap again to…"),
 * the second does it. Keep it disarms; so does leaving the sheet (the parent
 * resets `armed` in its onClose). When armed, the button announces its new
 * label and KEEPS focus (P12: no dangerous neighbours, no surprise).
 */
export function ItpDangerZone({
  label,
  armedLabel,
  consequence,
  armedConsequence,
  armed,
  busy = false,
  onArm,
  onConfirm,
  onKeep,
}: {
  /** "Remove area" */
  label: string;
  /** "Tap again to remove Kitchen" */
  armedLabel: string;
  /** "Removes Kitchen and its 3 photos from this ITP." */
  consequence: string;
  /** Shown instead while armed, e.g. "It goes from this ITP." */
  armedConsequence?: string;
  armed: boolean;
  busy?: boolean;
  onArm: () => void;
  onConfirm: () => void;
  onKeep: () => void;
}) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (armed) btnRef.current?.focus();
  }, [armed]);

  return (
    <div className="mt-5 border-t border-border pt-5">
      <button
        ref={btnRef}
        type="button"
        disabled={busy}
        onClick={armed ? onConfirm : onArm}
        aria-live="polite"
        className={cn(
          "inline-flex min-h-[56px] w-full items-center justify-center rounded-card border-2 px-4 font-display text-[17px] font-bold",
          styles.armable,
          armed
            ? "border-state-danger bg-state-danger text-text-inverse"
            : "border-state-danger bg-surface text-state-danger hover:bg-state-danger-subtle-bg",
          "focus-visible:outline-brand-navy disabled:cursor-not-allowed disabled:opacity-60"
        )}
      >
        {busy ? "Removing…" : armed ? armedLabel : label}
      </button>
      <p className="mt-2 text-[14px] font-semibold leading-snug text-text-muted">
        {armed ? (armedConsequence ?? consequence) : consequence}
      </p>
      {armed ? (
        <button
          type="button"
          onClick={onKeep}
          className="mt-1 inline-flex min-h-[44px] items-center px-1 font-display text-[16px] font-bold text-state-info focus-visible:outline-brand-navy"
        >
          Keep it
        </button>
      ) : null}
    </div>
  );
}
