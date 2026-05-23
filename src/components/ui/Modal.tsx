"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
}

/**
 * Minimal modal primitive. Closes on Escape and on backdrop click.
 * Phase A only needs a basic shell — focus trapping, scroll lock, and
 * portal mounting are deferred to Phase B+ when real modals exist.
 */
export function Modal({ open, onClose, title, children, className }: ModalProps) {
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
