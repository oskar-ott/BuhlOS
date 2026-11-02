"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The dock (handoff 2026-11-02 "Dock"): sticky to the bottom of the scroll
 * container, white, 1px border-strong top, padding 8 / 16. Always visible;
 * never scrolls away. `status` = badge(s) + one small action; `primary` =
 * the one big button. The status slot is aria-live=polite so "Saving 1 of 3",
 * "1 photo didn't save", "PDF made" and "Sent to office" are announced.
 *
 * It bleeds past the scroll container's 16px side padding (-mx-4) so it
 * runs edge to edge like the tab bar below it, which already clears the
 * home indicator.
 */
export function ItpDock({
  status,
  statusAction,
  hint,
  primary,
  testId,
}: {
  status?: ReactNode;
  statusAction?: ReactNode;
  /** A quiet line under the status row, e.g. the photo-cap count. */
  hint?: ReactNode;
  primary: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "sticky bottom-0 z-20 -mx-4 -mb-4 mt-auto border-t border-border-strong bg-surface px-4 pb-3 pt-2"
      )}
    >
      {status || statusAction ? (
        <div className="flex min-h-[48px] items-center justify-between gap-2">
          <div
            role="status"
            aria-live="polite"
            className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
          >
            {status}
          </div>
          {statusAction ? <div className="shrink-0">{statusAction}</div> : null}
        </div>
      ) : null}
      {hint ? <p className="pb-1 text-[14px] font-semibold text-text-muted">{hint}</p> : null}
      <div className="mt-1">{primary}</div>
    </div>
  );
}
