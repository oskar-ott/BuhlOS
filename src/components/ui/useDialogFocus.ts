"use client";

import { useEffect, useRef } from "react";

/**
 * Focus management for the shared Modal / Drawer primitives (#521): a focus
 * trap, focus restoration to the trigger on close, body scroll lock, and initial
 * focus on the first control. Escape / backdrop close stay in the components.
 *
 * The DOM wiring is preview-verified (the repo's vitest env is node-only, no
 * jsdom); the trap DECISION is the pure `resolveFocusTrapTarget` below, which is
 * unit-tested.
 */

const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * PURE: which focusable should receive focus to keep Tab trapped, or null to let
 * the browser's default Tab move within the dialog. Wraps at both ends, and pulls
 * focus back inside when it has escaped the set (active not found → idx -1).
 */
export function resolveFocusTrapTarget<T>(focusables: T[], active: T | null, shiftKey: boolean): T | null {
  if (focusables.length === 0) return null;
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const idx = active == null ? -1 : focusables.indexOf(active);
  if (shiftKey) {
    // At the first element (or escaped) → wrap/pull to the last.
    return idx <= 0 ? last : null;
  }
  // At the last element (or escaped) → wrap/pull to the first.
  return idx === -1 || idx === focusables.length - 1 ? first : null;
}

/** Attach the returned ref to the dialog panel element. No-op during SSR. */
export function useDialogFocus(open: boolean) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const panel = panelRef.current;
    const restoreTo = document.activeElement as HTMLElement | null;

    // Body scroll lock while the dialog is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusables = () =>
      panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : [];

    // Initial focus: the first control, else the panel itself.
    const first = focusables()[0];
    if (first) first.focus();
    else if (panel) {
      panel.tabIndex = -1;
      panel.focus();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const target = resolveFocusTrapTarget(
        focusables(),
        document.activeElement as HTMLElement | null,
        e.shiftKey,
      );
      if (target) {
        e.preventDefault();
        target.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = prevOverflow;
      // Return focus to whatever opened the dialog (the trigger).
      if (restoreTo && typeof restoreTo.focus === "function") restoreTo.focus();
    };
  }, [open]);

  return panelRef;
}
