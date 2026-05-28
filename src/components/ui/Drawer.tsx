"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** Main heading shown top-left of the drawer. */
  title: ReactNode;
  /** Small uppercase sub-label under the title (e.g. "step 1 of 4 · details"). */
  subtitle?: ReactNode;
  children: ReactNode;
  /** Sticky footer (the drawer's action row). */
  footer?: ReactNode;
  className?: string;
}

/**
 * Right-side slide-over drawer — the admin onboarding surface (bible §05:
 * "everything lives under /employees in the existing BuhlOS frame", drawer
 * width 420–480px, never full-page). Closes on Escape and backdrop click.
 *
 * Mirrors the Modal primitive's minimalism (no focus trap / scroll lock yet —
 * deferred with the rest of the Phase A primitives).
 */
export function Drawer({ open, onClose, title, subtitle, children, footer, className }: DrawerProps) {
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
      className="fixed inset-0 z-50 flex justify-end bg-accent-ink/40"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "flex h-full w-full max-w-[460px] flex-col bg-surface shadow-raised",
          className
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="font-display text-lg leading-tight text-text">{title}</h2>
            {subtitle ? (
              <p className="mt-1 font-mono text-[10.5px] uppercase tracking-wider text-text-muted">
                {subtitle}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-card border border-border p-1.5 text-text-muted hover:bg-surface-subtle"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer ? (
          <footer className="border-t border-border px-5 py-3">{footer}</footer>
        ) : null}
      </div>
    </div>
  );
}
