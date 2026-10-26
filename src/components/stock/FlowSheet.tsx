"use client";

import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { useDialogFocus } from "@/components/ui/useDialogFocus";
import { cn } from "@/lib/cn";
import { DirectionPill, type Direction } from "./ui";

/**
 * Full-screen sheet frame for the stock flows (phone-first; a centred card on
 * desktop). Header: Back · title · Close. Under it the DIRECTION pill says which
 * way stock is moving. The footer is pinned: the one named button lives there.
 * Focus is trapped and restored (useDialogFocus).
 *
 * The back-gesture guard is NOT here: the host screen arms one useSheetHistory
 * for "any stock sheet is open" (PhilWorkshopStock). Sheets hand over to each
 * other — take → "add it as new", item → take — and a guard per sheet would
 * unwind its marker with an async history.back() just as the next sheet pushes
 * its own, so the pop lands below the new marker and closes the new sheet.
 */
export function FlowSheet({
  title,
  onClose,
  onBack,
  busy = false,
  direction,
  directionNote,
  footer,
  children,
  bodyClassName,
  testId,
}: {
  title: string;
  onClose: () => void;
  onBack?: (() => void) | null;
  busy?: boolean;
  direction?: Direction | null;
  directionNote?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
  testId?: string;
}) {
  const panelRef = useDialogFocus(true);
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex items-stretch justify-center bg-accent-ink/40" data-testid={testId}>
      <div ref={panelRef} className="flex h-full w-full flex-col bg-surface pb-[env(safe-area-inset-bottom)] sm:my-6 sm:h-auto sm:max-h-[92vh] sm:max-w-lg sm:rounded-card sm:shadow-raised">
        <header className="flex shrink-0 items-center border-b border-border p-1.5">
          {onBack ? (
            <button type="button" onClick={onBack} disabled={busy} aria-label="Back" className="inline-flex min-h-[48px] min-w-[48px] items-center rounded-[10px] px-2 text-[15px] font-semibold text-brand-navy hover:bg-surface-subtle disabled:opacity-50">
              <ChevronLeft aria-hidden="true" className="h-5 w-5" strokeWidth={2.2} />
              Back
            </button>
          ) : (
            <span className="w-[76px]" aria-hidden="true" />
          )}
          <h2 className="min-w-0 flex-1 truncate text-center font-display text-lg font-bold text-brand-navy">{title}</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="inline-flex min-h-[48px] min-w-[48px] items-center justify-center rounded-[10px] px-2.5 text-[15px] font-semibold text-brand-navy hover:bg-surface-subtle disabled:opacity-50" data-testid={testId ? `${testId}-close` : undefined}>
            Close
          </button>
        </header>
        {direction ? (
          <div className="shrink-0 px-4 pt-2.5">
            <DirectionPill direction={direction} note={directionNote} />
          </div>
        ) : null}
        <div className={cn("flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3", bodyClassName)}>{children}</div>
        {footer ? <footer className="shrink-0 space-y-2.5 border-t border-border bg-surface px-4 pb-4 pt-3">{footer}</footer> : null}
      </div>
    </div>
  );
}
