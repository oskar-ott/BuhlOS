"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useDialogFocus } from "./useDialogFocus";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}

/**
 * Modal primitive. Closes on Escape and backdrop click; traps Tab within the
 * dialog, locks body scroll, focuses the first control on open, and restores
 * focus to the trigger on close (#521 — focus management for the 17 Modal
 * consumers incl. destructive admin sign-off / evidence-reject).
 */
export function Modal({ open, onClose, title, children, className }: ModalProps) {
  const panelRef = useDialogFocus(open);

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-accent-ink/40 p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "w-full max-w-lg rounded-card bg-surface-raised shadow-raised p-6",
          className
        )}
      >
        <h2 className="font-display text-lg text-text">{title}</h2>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
