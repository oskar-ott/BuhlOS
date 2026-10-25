"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useDialogFocus } from "@/components/ui/useDialogFocus";
import { useSheetHistory } from "../useSheetHistory";
import type { HoursProblem } from "@/domains/timesheets/problem";
import { ProblemBlock } from "./ProblemBlock";
import styles from "./hours.module.css";

/**
 * The one bottom-sheet shell for the Hours screen (docs/phil-hours.md):
 * handle · title · day/job line · Close (icon + text, 48px) · body · footer.
 * The footer carries the review line ("You're sending" + the exact receipt
 * words) and the yellow Send button — or, when nothing can be sent yet, a
 * reason line instead of a button. A failed send sits in this same footer
 * (the slot that failed), with its own Try again.
 *
 * Close and swipe-down both close it; so does the OS back gesture
 * (useSheetHistory) and Escape. Slides up over 250ms.
 */
export interface SheetFooter {
  /** "You're sending" + receipt words. */
  review?: { lead: string; line: string } | null;
  /** When nothing can be sent yet — shown INSTEAD of the Send button. */
  reason?: string | null;
  send?: {
    label: string;
    sub?: string;
    onClick: () => void;
    busy?: boolean;
    testId?: string;
  } | null;
  /** A failed send, in this slot. */
  problem?: { problem: HoursProblem; onRetry?: (() => void) | null; retryLabel?: string } | null;
  /** A quiet line under everything (e.g. where to find Sick day / Holiday). */
  note?: ReactNode;
}

export function HoursSheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  testId,
  /** Stack order — a sheet opened from inside another sheet passes `true`. */
  nested = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string | null;
  children: ReactNode;
  footer?: SheetFooter | null;
  testId?: string;
  nested?: boolean;
}): ReactNode {
  const { closeWithHistory } = useSheetHistory({ open, onClose });
  const panelRef = useDialogFocus(open);
  const titleId = useId();
  const startY = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeWithHistory();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // closeWithHistory is a fresh closure each render; the hook keeps the
    // latest onClose in a ref, so re-binding on `open` alone is correct.
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
        "fixed inset-0 flex items-end justify-center bg-slate-900/50",
        nested ? "z-[70]" : "z-[60]",
        styles.sheetBackdrop
      )}
      onClick={closeWithHistory}
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        // Swipe down on the header closes (a shortcut — Close is always there).
        onTouchStart={(e) => {
          startY.current = e.touches[0]?.clientY ?? null;
        }}
        onTouchEnd={(e) => {
          const start = startY.current;
          const end = e.changedTouches[0]?.clientY;
          startY.current = null;
          if (start != null && end != null && end - start > 80) {
            const target = e.target as HTMLElement | null;
            // Only a drag that began on the handle / title area, not inside a
            // scrolling body or a field.
            if (target?.closest("[data-sheet-grab]")) closeWithHistory();
          }
        }}
        className={cn(
          "flex max-h-[92dvh] w-full max-w-md flex-col rounded-t-[20px] bg-surface text-text shadow-raised",
          styles.sheetPanel
        )}
      >
        <div data-sheet-grab className="shrink-0 px-4 pt-2">
          <div aria-hidden="true" className="mx-auto h-1.5 w-12 rounded-pill bg-border-strong" />
          <div className="mt-2 flex items-start justify-between gap-3">
            <div className="min-w-0 pt-1">
              <h2
                id={titleId}
                className="font-display text-[20px] font-bold leading-tight tracking-tight"
              >
                {title}
              </h2>
              {subtitle ? <p className="mt-0.5 text-[14px] text-text-muted">{subtitle}</p> : null}
            </div>
            <button
              type="button"
              onClick={closeWithHistory}
              data-testid="hours-sheet-close"
              className="inline-flex h-12 shrink-0 items-center gap-1 rounded-card border border-border px-3 font-display text-[15px] font-semibold text-text active:bg-surface-subtle"
            >
              <X aria-hidden="true" className="h-4 w-4" />
              Close
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-4">{children}</div>

        {footer ? <Footer footer={footer} /> : null}
      </div>
    </div>
  );
}

function Footer({ footer }: { footer: SheetFooter }): ReactNode {
  return (
    <div className="shrink-0 space-y-3 border-t border-border bg-surface px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3">
      {footer.problem ? (
        <ProblemBlock
          problem={footer.problem.problem}
          onRetry={footer.problem.onRetry ?? undefined}
          retryLabel={footer.problem.retryLabel}
        />
      ) : null}
      {footer.review ? (
        <p className="text-[14px] text-text-muted" data-testid="hours-sheet-review">
          <span className="font-semibold text-text">{footer.review.lead}</span>{" "}
          <span className="tabular-nums">{footer.review.line}</span>
        </p>
      ) : null}
      {footer.send && !footer.reason ? (
        <button
          type="button"
          onClick={footer.send.onClick}
          disabled={footer.send.busy}
          aria-busy={footer.send.busy || undefined}
          data-testid={footer.send.testId ?? "hours-sheet-send"}
          className="flex min-h-[64px] w-full flex-col items-center justify-center rounded-[14px] bg-accent-yellow px-4 py-2 text-accent-ink active:scale-[0.99] disabled:cursor-wait"
        >
          <span className="font-display text-[17px] font-bold leading-tight tabular-nums">
            {footer.send.busy ? "Saving…" : footer.send.label}
          </span>
          {footer.send.sub && !footer.send.busy ? (
            <span className="mt-0.5 text-[13px] font-medium text-accent-ink/80">
              {footer.send.sub}
            </span>
          ) : null}
        </button>
      ) : footer.reason ? (
        <p
          className="rounded-card bg-surface-subtle px-3 py-3 text-[14px] text-text-muted"
          role="status"
        >
          {footer.reason}
        </p>
      ) : null}
      {footer.note ? <div className="text-[13px] text-text-muted">{footer.note}</div> : null}
    </div>
  );
}
