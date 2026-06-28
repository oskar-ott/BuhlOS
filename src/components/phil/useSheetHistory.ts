"use client";

import { useEffect, useRef } from "react";

/**
 * Phil — sheet back-safety (#149, slice 1).
 *
 * Makes a swipe-back / Android hardware-back / browser-back gesture CLOSE an
 * open sheet instead of navigating the page away. The data-loss case is the
 * Capture launcher's photo tray (it lives in useState and deliberately survives
 * a close): an accidental back-swipe must close the sheet WITHOUT losing the
 * shots — never leave the field surface.
 *
 * Constitution: serves P8 (the field worker doesn't lose work to an accidental
 * interruption) via an ADDITIVE behaviour under P10 — every sheet keeps its
 * visible Close/Cancel path; this only intercepts the OS back gesture. The
 * existing nav contract (place-first navigation, the ?fixDate= URL flow) is
 * untouched: this hook is scoped to user-toggled in-component sub-sheets, the
 * launcher, and the standalone {open,onClose} sheets — NOT the URL-driven
 * fixDate sheets, which keep their existing history contract.
 *
 * MECHANISM
 *   On open we `history.pushState` a sentinel marker entry. A `popstate` that
 *   leaves us BELOW that marker (the back gesture popped it) means the worker
 *   pressed back: we call onClose instead of letting the page navigate. A
 *   PROGRAMMATIC close (Close button / Esc / successful submit) calls
 *   history.back() ONLY when our marker is still the top entry — so we unwind
 *   the entry we pushed and never orphan it, and the marker-check makes a
 *   Close-tap-then-immediate-swipe pop exactly once (no double-back race).
 *
 * Like useLongPress, the decision is a PURE reducer (`sheetHistoryReducer`)
 * unit-tested in node with no DOM; the hook is a thin shell that wires real
 * history events onto it.
 *
 * Cross-ref:
 *   src/components/phil/longPressReducer.ts — the same pure-reducer + thin-hook shape
 *   docs/phil-constitution.md — P8 (survives interruption), P10 (cognitive budget)
 */

/** A unique tag stamped into the pushed history entry's state so a popstate can
 *  tell OUR sentinel from any other history entry on the stack. */
export const SHEET_HISTORY_MARKER = "__philSheet__";

export interface SheetHistoryState {
  /** True once we've pushed our sentinel entry and it is still the top entry —
   *  i.e. a back gesture will pop US, and a programmatic close should unwind it
   *  with history.back(). Cleared the instant either path consumes the marker,
   *  so the marker is single-shot and the double-back race pops only once. */
  marked: boolean;
}

export const SHEET_HISTORY_INITIAL: SheetHistoryState = { marked: false };

/**
 * Events the reducer folds over. All are derived from real lifecycle/DOM facts
 * by the hook; the reducer itself is pure and timer/DOM-free.
 *
 *   open               the sheet opened → we should push a marker (if not marked)
 *   pushed             the marker push actually happened → now armed
 *   popped-marker      a popstate fired that left us below OUR marker → close
 *   programmatic-close Close/Esc/submit asked to close → unwind via back() iff marked
 *   close              the sheet closed/unmounted → unwind the orphan iff still
 *                      marked (a parent-driven `open=false` that bypassed
 *                      closeWithHistory, e.g. a successful submit that just
 *                      flips the parent's state), otherwise disarm
 */
export type SheetHistoryEvent =
  | { type: "open" }
  | { type: "pushed" }
  | { type: "popped-marker" }
  | { type: "programmatic-close" }
  | { type: "close" };

/**
 * What the host should DO as a side effect after a transition. The hook reads
 * this; the reducer never touches history itself (keeps it pure + testable).
 *
 *   none      do nothing
 *   push      history.pushState the sentinel (then dispatch "pushed")
 *   back      history.back() to unwind our own marker entry
 *   onClose   invoke the sheet's onClose (a back gesture popped our marker)
 */
export type SheetHistoryEffect = "none" | "push" | "back" | "onClose";

export interface SheetHistoryResult {
  state: SheetHistoryState;
  effect: SheetHistoryEffect;
}

/**
 * Pure transition. Deterministic — same state + event always yields the same
 * next state AND the same effect — so the whole back-stack decision is
 * exhaustively node-testable.
 *
 *   open (unmarked)            → push the marker            [effect: push]
 *   open (already marked)      → no-op (idempotent reopen)  [effect: none]
 *   pushed                     → armed (marked)             [effect: none]
 *   popped-marker (marked)     → disarm + close the sheet   [effect: onClose]
 *   popped-marker (unmarked)   → no-op (not our pop)        [effect: none]
 *   programmatic-close (marked)   → disarm + unwind entry   [effect: back]
 *   programmatic-close (unmarked) → no-op (nothing to undo) [effect: none]
 *   close (marked)             → disarm + unwind the orphan [effect: back]
 *   close (unmarked)           → disarm, no history action  [effect: none]
 *
 * The marker is single-shot: `popped-marker`, `programmatic-close` AND `close`
 * all clear it. So a Close-tap (programmatic-close → back, marker cleared)
 * followed by an immediate swipe (popped-marker on an unmarked state → no-op)
 * pops the entry exactly once — no double-back, no orphaned entry. And a
 * parent-driven close after closeWithHistory already cleared the marker is a
 * plain disarm (no second back), while a parent-driven close that bypassed it
 * unwinds the still-present entry exactly once.
 */
export function sheetHistoryReducer(
  state: SheetHistoryState,
  event: SheetHistoryEvent,
): SheetHistoryResult {
  switch (event.type) {
    case "open":
      // Idempotent: a re-open while already armed must not stack a second entry.
      return state.marked
        ? { state, effect: "none" }
        : { state: { marked: false }, effect: "push" };

    case "pushed":
      return { state: { marked: true }, effect: "none" };

    case "popped-marker":
      // Only act if WE are the marked top entry. Clearing first makes the pop
      // single-shot (a racing programmatic close then finds nothing to unwind).
      return state.marked
        ? { state: { marked: false }, effect: "onClose" }
        : { state, effect: "none" };

    case "programmatic-close":
      // Unwind our own pushed entry only while it is still the top one; if a
      // back gesture already consumed it, there is nothing to undo.
      return state.marked
        ? { state: { marked: false }, effect: "back" }
        : { state, effect: "none" };

    case "close":
      // A close/unmount that still holds the marker (parent flipped open=false
      // without going through closeWithHistory — e.g. a successful submit) must
      // unwind the orphan entry. If the marker was already consumed (the normal
      // closeWithHistory path, or a back gesture), this is a plain disarm.
      return state.marked
        ? { state: SHEET_HISTORY_INITIAL, effect: "back" }
        : { state: SHEET_HISTORY_INITIAL, effect: "none" };
  }
}

export interface UseSheetHistoryOptions {
  /** Whether the sheet is currently open. */
  open: boolean;
  /** Close the sheet. Called when a back gesture pops our sentinel marker. */
  onClose: () => void;
}

export interface SheetHistoryHandle {
  /**
   * Wrap the sheet's programmatic close (Close button, Esc, successful submit)
   * so it unwinds the pushed marker via history.back() when our marker is still
   * the top entry — guarded so there is no orphan entry and no double-back.
   * Call this INSTEAD of onClose from the buttons/Esc/submit paths.
   */
  closeWithHistory: () => void;
}

/** Is the History API available + safe to drive (client, with a state object)? */
function hasHistory(): boolean {
  return typeof window !== "undefined" && typeof window.history?.pushState === "function";
}

/** Did this popstate land below OUR sentinel marker? After back() pops the
 *  marker entry, history.state no longer carries our tag. */
function poppedOurMarker(ev: PopStateEvent): boolean {
  const s = ev.state as Record<string, unknown> | null;
  return !(s && s[SHEET_HISTORY_MARKER] === true);
}

/**
 * The thin React shell over the pure reducer. Wires:
 *   - open → push a sentinel history entry,
 *   - popstate (our marker popped) → onClose,
 *   - closeWithHistory() → guarded history.back().
 *
 * The latest onClose lives in a ref so the popstate listener identity is stable
 * and never goes stale. The reducer state lives in a ref too (no re-render is
 * needed — these are side-effect transitions, like the long-press controller).
 */
export function useSheetHistory({ open, onClose }: UseSheetHistoryOptions): SheetHistoryHandle {
  const stateRef = useRef<SheetHistoryState>(SHEET_HISTORY_INITIAL);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Apply an event through the reducer and run its side effect on real history.
  const dispatchRef = useRef<(e: SheetHistoryEvent) => void>(() => {});
  dispatchRef.current = (event: SheetHistoryEvent) => {
    const { state, effect } = sheetHistoryReducer(stateRef.current, event);
    stateRef.current = state;
    if (!hasHistory()) return;
    switch (effect) {
      case "push":
        window.history.pushState(
          { ...(window.history.state ?? {}), [SHEET_HISTORY_MARKER]: true },
          "",
        );
        dispatchRef.current({ type: "pushed" });
        break;
      case "back":
        window.history.back();
        break;
      case "onClose":
        onCloseRef.current();
        break;
      case "none":
        break;
    }
  };

  // Push the sentinel on open; disarm on close/unmount. A back gesture mid-open
  // pops our marker (handled by the popstate listener); if the sheet is closed
  // any other way the cleanup just disarms — it does NOT call back() (that is
  // the explicit closeWithHistory path), so we never fight a real navigation.
  useEffect(() => {
    if (!open) return;
    dispatchRef.current({ type: "open" });
    return () => {
      dispatchRef.current({ type: "close" });
    };
  }, [open]);

  // A popstate that left us below our marker, while the sheet is open, is the
  // worker pressing back → close the sheet rather than navigate the page.
  useEffect(() => {
    if (!open) return;
    function onPop(ev: PopStateEvent) {
      if (poppedOurMarker(ev)) {
        dispatchRef.current({ type: "popped-marker" });
      }
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [open]);

  return {
    closeWithHistory: () => {
      // Unwind our own pushed entry (guarded by the marker), THEN close. The
      // reducer guarantees back() runs at most once per marker, so a Close tap
      // immediately followed by a swipe never pops two entries.
      dispatchRef.current({ type: "programmatic-close" });
      onCloseRef.current();
    },
  };
}
