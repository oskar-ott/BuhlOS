/**
 * Phil — long-press gesture state machine (#146).
 *
 * A pure reducer over a four-state machine so the gesture's correctness — when a
 * hold fires, when a tap passes through untouched, when a scroll cancels — is
 * unit-tested with NO DOM and no timers. The hook (useLongPress.ts) is a thin
 * shell that wires real pointer events + a real timer onto this reducer.
 *
 * Constitution: this serves P14 (faster access to the jobs/actions a worker
 * repeats) via an ADDITIVE gesture under P10 — every shortcut a long-press opens
 * still has a visible normal path (the FAB's plain tap, the job row's tap). The
 * load-bearing rule lives here: a PLAIN TAP must never be turned into a hold, so
 * the camera-first FAB tap keeps firing synchronously inside the user gesture
 * (iOS file-input requirement). Only a COMPLETED hold (`fired`) asks the caller
 * to suppress the synthetic click that follows.
 *
 * States:
 *   - idle       nothing happening.
 *   - pressing   a qualifying pointer is down; the hold timer is running.
 *   - fired      the timer elapsed while still pressing → onLongPress should run,
 *                and the next click is the synthetic one to suppress.
 *   - cancelled  the press ended before the threshold (a tap), or the pointer
 *                moved past the slop (a scroll), or was cancelled by the system.
 *                A tap passes straight through — the caller does NOTHING special.
 *
 * Cross-ref:
 *   src/components/phil/useLongPress.ts — the hook that drives this
 *   docs/phil-constitution.md — P10 (cognitive budget), P14 (Phil remembers)
 */

export type LongPressPhase = "idle" | "pressing" | "fired" | "cancelled";

export interface LongPressState {
  phase: LongPressPhase;
  /** Pointer position at press-start, used to measure move-slop. Null off-press. */
  origin: { x: number; y: number } | null;
}

export const LONG_PRESS_INITIAL: LongPressState = { phase: "idle", origin: null };

/**
 * Why a press is cancelled — useful for the hook to decide click-suppression:
 * a `tap` is a normal short press that must pass through untouched.
 */
export type LongPressCancelReason = "tap" | "move" | "system";

export type LongPressEvent =
  | { type: "down"; x: number; y: number }
  | { type: "move"; x: number; y: number; slop: number }
  | { type: "up" }
  | { type: "timer" }
  | { type: "cancel" }
  | { type: "reset" };

/**
 * Whether the press has actually moved past the slop radius (a scroll, not a
 * hold). Uses squared distance so there is no sqrt and no floating drift.
 */
export function exceedsSlop(
  origin: { x: number; y: number } | null,
  x: number,
  y: number,
  slop: number,
): boolean {
  if (!origin) return false;
  const dx = x - origin.x;
  const dy = y - origin.y;
  return dx * dx + dy * dy > slop * slop;
}

/**
 * Pure transition. Deterministic — same state + event always yields the same
 * next state — so the whole gesture is exhaustively testable in node.
 *
 *   down                       → pressing (timer starts in the hook)
 *   timer (while pressing)     → fired      (onLongPress; suppress next click)
 *   up (while pressing)        → cancelled  (a TAP — passes through untouched)
 *   move past slop (pressing)  → cancelled  (a SCROLL — never a hold)
 *   cancel (system)            → cancelled
 *   reset / up-after-fired     → idle       (ready for the next gesture)
 *
 * A `timer` that arrives after the press already ended is a no-op (the hook
 * clears the timer on up/cancel, but the reducer stays safe regardless).
 */
export function longPressReducer(
  state: LongPressState,
  event: LongPressEvent,
): LongPressState {
  switch (event.type) {
    case "down":
      // A fresh press always restarts the machine, even from `fired`/`cancelled`.
      return { phase: "pressing", origin: { x: event.x, y: event.y } };

    case "move":
      if (state.phase !== "pressing") return state;
      return exceedsSlop(state.origin, event.x, event.y, event.slop)
        ? { phase: "cancelled", origin: null }
        : state;

    case "up":
      // A release while still pressing is a TAP — cancel without firing.
      if (state.phase === "pressing") return { phase: "cancelled", origin: null };
      // After a fired hold, release returns to idle (the click-suppress already
      // armed off `fired`).
      if (state.phase === "fired") return { phase: "idle", origin: null };
      return state;

    case "timer":
      // Only a press that is still down may complete into a hold.
      return state.phase === "pressing" ? { phase: "fired", origin: null } : state;

    case "cancel":
      return state.phase === "idle" ? state : { phase: "cancelled", origin: null };

    case "reset":
      return LONG_PRESS_INITIAL;
  }
}

/**
 * Classify how a press ended, for the hook's click-suppression decision. Pure so
 * it can be asserted directly. Only a hold that genuinely `fired` should suppress
 * the synthetic click; a tap (`cancelled` via up) must pass through (the FAB's
 * camera tap depends on this).
 */
export function shouldSuppressClick(state: LongPressState): boolean {
  return state.phase === "fired";
}
