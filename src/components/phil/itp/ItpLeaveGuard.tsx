"use client";

import { useEffect, useId, useRef } from "react";
import { plural } from "@/domains/itp-simple/model";
import { ItpPrimaryButton, ItpSecondaryButton } from "./ItpControls";

/**
 * Leave guard (board 5e): "3 photos haven't saved" · "They're only on this
 * phone. Leave now and they're gone." · Stay here (primary) · Leave anyway.
 * Shown on back / route change while any photo is Waiting, Saving, Not sent
 * or Didn't save. A closed tab or killed app can't be caught — that's the
 * honest limit without an offline queue. Assertive: it's the one dialog
 * worth interrupting for.
 */
export function ItpLeaveGuard({
  open,
  count,
  onStay,
  onLeave,
}: {
  open: boolean;
  count: number;
  onStay: () => void;
  onLeave: () => void;
}) {
  const titleId = useId();
  const stayRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (open) stayRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onStay();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onStay]);

  if (!open) return null;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-live="assertive"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-[rgba(15,23,42,0.5)] p-6"
      data-testid="itp-leave-guard"
    >
      <div className="w-full max-w-sm space-y-3 rounded-[20px] bg-surface p-5 text-text shadow-raised">
        <h2 id={titleId} className="font-display text-[22px] font-bold leading-tight">
          {`${plural(count, "photo hasn't", "photos haven't")} saved`}
        </h2>
        <p className="text-[16px] leading-snug text-text-muted">
          They&rsquo;re only on this phone. Leave now and they&rsquo;re gone.
        </p>
        <ItpPrimaryButton ref={stayRef} onClick={onStay}>
          Stay here
        </ItpPrimaryButton>
        <ItpSecondaryButton onClick={onLeave}>Leave anyway</ItpSecondaryButton>
      </div>
    </div>
  );
}
