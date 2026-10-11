"use client";

import { useEffect, useId, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "./Button";
import { useDialogFocus } from "./useDialogFocus";
import type { HoursProblem } from "@/domains/timesheets/problem";

/**
 * The pop-up that explains a failed hours / timesheet action in plain words
 * (owner pull 2026-10-11: "clear instructions to pop up if there is an error —
 * simple explanations of what went wrong and why"). The words come from
 * `explainHoursProblem`; this only shows them:
 *
 *   caption — what didn't happen ("Fix not saved")
 *   title   — what went wrong ("This day's already approved")
 *   why     — one sentence
 *   todo    — what to do next, under "What to do"
 *
 * An alertdialog: it takes focus, Escape / OK / the backdrop close it, and it
 * sits ABOVE the phone closeout's review sheet (z-[60]) so a failure inside the
 * sheet is never hidden behind it (P9). A bottom sheet on a phone, centred on a
 * desk. "Try again" only when retrying straight away can work and the caller
 * can do it. Whatever was typed stays put underneath — nothing is lost (P7).
 */
export function ProblemDialog({
  problem,
  onClose,
  onRetry,
}: {
  problem: HoursProblem | null;
  onClose: () => void;
  onRetry?: () => void;
}): ReactNode {
  const open = problem !== null;
  const panelRef = useDialogFocus(open);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!problem) return null;
  const retry = problem.canRetry && onRetry ? onRetry : null;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-testid="problem-dialog"
      // bg-slate-900/50, not bg-accent-ink/40: accent-ink is a CSS-var colour,
      // which Tailwind can't make translucent — that class renders no dim.
      className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-900/50 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-t-card bg-surface p-5 text-text shadow-raised sm:rounded-card"
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700"
          >
            <AlertTriangle className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
              {problem.caption}
            </p>
            <h2 id={titleId} className="mt-0.5 font-display text-lg font-semibold text-text">
              {problem.title}
            </h2>
          </div>
        </div>
        <div id={bodyId} className="mt-3 space-y-3 text-sm">
          <p className="text-text-muted" data-testid="problem-why">
            {problem.why}
          </p>
          <div className="rounded-card border border-border bg-surface-subtle p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">What to do</p>
            <p className="mt-1 font-medium text-text" data-testid="problem-todo">
              {problem.todo}
            </p>
          </div>
        </div>
        {/* OK first in reading and focus order — it's always safe; on a desk
            row-reverse puts it at the right like every other dialog. */}
        <div className="mt-4 flex flex-col gap-2 sm:flex-row-reverse sm:justify-start">
          <Button size="lg" onClick={onClose} data-testid="problem-ok">
            OK
          </Button>
          {retry ? (
            <Button
              variant="secondary"
              size="lg"
              onClick={() => {
                onClose();
                retry();
              }}
              data-testid="problem-retry"
            >
              Try again
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
