"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/cn";
import { useDialogFocus } from "@/components/ui/useDialogFocus";
import { useSheetHistory } from "../useSheetHistory";
import { ItpTextButton } from "./ItpControls";
import styles from "./itp.module.css";

/**
 * The one bottom sheet for the ITP screens (handoff 2026-11-02 "Bottom
 * sheet"): grab handle · title (+ optional subtitle) · Close · optional back ·
 * body. One at a time, over a scrim. Close, scrim tap, swipe down, the OS
 * back gesture (useSheetHistory) and Escape all dismiss it; the caller's
 * onClose disarms any armed remove.
 *
 * role=dialog aria-modal, labelled by the title; focus moves to the title
 * on open and returns to the opener on close (useDialogFocus restores).
 * Slides up 220ms; reduced motion = instant.
 */
export function ItpSheet({
  open,
  onClose,
  title,
  subtitle,
  back,
  children,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string | null;
  /** A back control in the header, e.g. "Send" from the Email it sheet. */
  back?: { label: string; onClick: () => void } | null;
  children: ReactNode;
  testId?: string;
}): ReactNode {
  const { closeWithHistory } = useSheetHistory({ open, onClose });
  const panelRef = useDialogFocus(open);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const titleId = useId();
  const startY = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    // Focus the title (not the first control) so the screen reader hears
    // what opened before the first field grabs focus.
    titleRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeWithHistory();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // closeWithHistory keeps the latest onClose in a ref; rebinding on `open`
    // alone is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid={testId}
      className={cn(
        "fixed inset-0 z-[60] flex items-end justify-center bg-[rgba(15,23,42,0.5)]",
        styles.sheetScrim
      )}
      onClick={closeWithHistory}
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => {
          startY.current = e.touches[0]?.clientY ?? null;
        }}
        onTouchEnd={(e) => {
          const start = startY.current;
          const end = e.changedTouches[0]?.clientY;
          startY.current = null;
          if (start != null && end != null && end - start > 80) {
            const target = e.target as HTMLElement | null;
            if (target?.closest("[data-sheet-grab]")) closeWithHistory();
          }
        }}
        className={cn(
          "flex max-h-[92dvh] w-full max-w-md flex-col rounded-t-[20px] bg-surface text-text shadow-raised",
          styles.sheetPanel
        )}
      >
        <div data-sheet-grab className="shrink-0 px-4 pt-2">
          <div aria-hidden="true" className="mx-auto h-1 w-10 rounded-pill bg-border-strong" />
          <div className="mt-2 flex items-center justify-between gap-2">
            {back ? (
              <ItpTextButton onClick={back.onClick} className="-ml-2 pl-1 pr-2">
                <ChevronLeft aria-hidden="true" className="h-5 w-5" />
                {back.label}
              </ItpTextButton>
            ) : null}
            <div className="min-w-0 flex-1 py-1">
              <h2
                id={titleId}
                ref={titleRef}
                tabIndex={-1}
                className="line-clamp-2 break-words font-display text-[22px] font-bold leading-tight tracking-tight outline-none"
              >
                {title}
              </h2>
              {subtitle ? (
                <p className="mt-0.5 text-[14px] font-semibold text-text-muted">{subtitle}</p>
              ) : null}
            </div>
            <ItpTextButton onClick={closeWithHistory} data-testid="itp-sheet-close">
              Close
            </ItpTextButton>
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-7 pt-3">{children}</div>
      </div>
    </div>
  );
}
