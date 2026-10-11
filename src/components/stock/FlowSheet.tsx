"use client";

import type { ReactNode } from "react";
import { ArrowLeft, X } from "lucide-react";
import { useDialogFocus } from "@/components/ui/useDialogFocus";

/**
 * Full-screen sheet frame for the stock flows (phone-first; a centred card on
 * desktop). Focus is trapped and restored (useDialogFocus).
 *
 * The back-gesture guard is NOT here: the host screen arms one
 * useSheetHistory for "any stock sheet is open" (PhilWorkshopStock). Sheets
 * hand over to each other — take → "add it as new", item → take — and a guard
 * per sheet would unwind its marker with an async history.back() just as the
 * next sheet pushes its own, so the pop lands below the new marker and closes
 * the new sheet (React's dev double-mount trips the same race).
 */
export function FlowSheet({
  title,
  onClose,
  onBack,
  busy = false,
  footer,
  children,
  testId,
}: {
  title: string;
  onClose: () => void;
  onBack?: (() => void) | null;
  busy?: boolean;
  footer?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  const panelRef = useDialogFocus(true);
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex items-stretch justify-center bg-accent-ink/40" data-testid={testId}>
      <div ref={panelRef} className="flex h-full w-full flex-col bg-surface pb-[env(safe-area-inset-bottom)] sm:my-6 sm:h-auto sm:max-h-[92vh] sm:max-w-lg sm:rounded-card sm:shadow-raised">
        <header className="flex items-center gap-2 border-b border-border px-2 py-2">
          {onBack ? (
            <button type="button" onClick={onBack} disabled={busy} aria-label="Back" className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-card text-text-muted hover:bg-surface-subtle disabled:opacity-50">
              <ArrowLeft aria-hidden="true" className="h-5 w-5" />
            </button>
          ) : (
            <span className="w-2" aria-hidden="true" />
          )}
          <h2 className="min-w-0 flex-1 truncate font-display text-lg text-text">{title}</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-card text-text-muted hover:bg-surface-subtle disabled:opacity-50" data-testid={testId ? `${testId}-close` : undefined}>
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">{children}</div>
        {footer ? <footer className="space-y-2 border-t border-border px-4 py-3">{footer}</footer> : null}
      </div>
    </div>
  );
}
