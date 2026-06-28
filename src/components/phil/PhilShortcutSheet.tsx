"use client";

import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";

/**
 * Phil — a small, thumb-reachable bottom sheet for long-press shortcuts (#146).
 *
 * Shared shell for the two long-press menus: the FAB's "capture into a recent
 * job" sheet and a job row's "top actions" sheet. Deliberately tiny — a title, a
 * close affordance, and a slot — so each caller owns its own (short) list. Sits
 * at the BOTTOM of the screen so the options land under the thumb that just held
 * (P8 — one thumb, reachable). Backdrop tap + Esc close; nothing here writes.
 *
 * This is additive, never a new navigation paradigm (P10): the sheet only ever
 * lists actions that ALSO have a visible normal path — its items are launchable
 * shortcuts, not new destinations.
 */
export function PhilShortcutSheet({
  open,
  onClose,
  title,
  subtitle,
  testId,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  testId?: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid={testId}
      className="fixed inset-0 z-50 flex items-end justify-center bg-accent-ink/40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-t-card border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] shadow-raised"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="font-display text-base font-semibold text-text">{title}</h2>
            {subtitle ? (
              <p className="mt-0.5 truncate text-xs text-text-muted">{subtitle}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-card text-text-muted hover:bg-surface-subtle"
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </header>
        <div className="px-4 py-3">{children}</div>
      </div>
    </div>
  );
}
