"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  LONG_PRESS_INITIAL,
  longPressReducer,
  shouldSuppressClick,
  type LongPressState,
} from "./longPressReducer";

/**
 * Phil — long-press pointer hook (#146).
 *
 * Returns props you spread onto a touchable element to add a long-press gesture
 * WITHOUT changing its tap. A ~450ms hold (touch/pen only — mouse is skipped so
 * the desktop office never gets a phantom gesture) calls `onLongPress`; a normal
 * tap, a scroll past a small slop, or a system cancel does nothing.
 *
 * LOAD-BEARING — tap transparency (see issue #146 + P10):
 *   This hook attaches ONLY pointer/contextmenu handlers. It never owns the
 *   element's `onClick`. The host keeps its synchronous onClick (e.g. the FAB's
 *   camera fire, which iOS requires inside the user gesture). The hook's only
 *   click involvement is to SUPPRESS the single synthetic click that the browser
 *   dispatches AFTER a completed long-press — and only then. A plain tap is never
 *   suppressed, so the FAB camera tap and the job-row navigation are untouched.
 *
 * The gesture's logic is the pure `longPressReducer`; the framework-free
 * `createLongPressController` adds the timer, the pointerType guard, and the
 * suppress-next-click latch. The hook itself is a thin React shell over that
 * controller, so the gesture is driveable in a node test with fake timers (no
 * DOM) — see PhilTabBar.interaction.test.tsx.
 *
 * Cross-ref:
 *   src/components/phil/longPressReducer.ts — the pure state machine
 *   src/components/phil/PhilTabBar.tsx — the FAB shortcut sheet host
 *   src/components/phil/PhilJobsList.tsx — the job-row actions host
 */

export interface UseLongPressOptions {
  /** Fired once when a qualifying hold completes. */
  onLongPress: () => void;
  /** Hold duration before firing. Defaults to 450ms (a deliberate press, not a
   *  fat-finger tap, and short enough not to feel laggy). */
  thresholdMs?: number;
  /** Movement (px) tolerated during the hold before it's treated as a scroll. */
  slopPx?: number;
  /** Skip the whole gesture (e.g. while a sheet is already open). */
  disabled?: boolean;
}

export interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerLeave: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
  /** Suppresses ONLY the synthetic click after a completed hold. */
  onClickCapture: (e: React.MouseEvent) => void;
  /** Long-press opens a menu/sheet — block the native context menu so the OS
   *  text-selection / callout menu never competes with it. */
  onContextMenu: (e: React.MouseEvent) => void;
}

const DEFAULT_THRESHOLD_MS = 450;
const DEFAULT_SLOP_PX = 10;

/** Touch + pen open the gesture; mouse does not (desktop has no long-press
 *  idiom, and the office surface must not sprout a phantom hold). */
function isTouchLike(pointerType: string): boolean {
  return pointerType === "touch" || pointerType === "pen";
}

/** The minimal pointer/mouse-event shape the controller reads — so the engine
 *  is testable with plain objects (no real DOM event needed). A real
 *  React.PointerEvent / React.MouseEvent satisfies these structurally, so the
 *  same controller spreads onto JSX. */
export interface PointerLike {
  pointerType: string;
  clientX: number;
  clientY: number;
}
export interface ClickLike {
  preventDefault: () => void;
  stopPropagation: () => void;
}

/** The controller's handler set, typed against the minimal event shapes so it
 *  is drivable from a node test AND spreadable onto a DOM element. */
export interface LongPressController {
  onPointerDown: (e: PointerLike) => void;
  onPointerMove: (e: PointerLike) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onClickCapture: (e: ClickLike) => void;
  onContextMenu: (e: ClickLike) => void;
}

/** Injectable timer so a test can drive the threshold deterministically; the
 *  hook passes the real setTimeout/clearTimeout. */
export interface LongPressScheduler {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const realScheduler: LongPressScheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * The framework-free gesture engine. Owns the reducer state, the hold timer, and
 * the single-shot click-suppress latch, and exposes the handler set. Pure of
 * React — the hook wraps it; the interaction test drives it directly.
 */
export function createLongPressController(opts: {
  onLongPress: () => void;
  thresholdMs?: number;
  slopPx?: number;
  isDisabled?: () => boolean;
  scheduler?: LongPressScheduler;
}): LongPressController {
  const thresholdMs = opts.thresholdMs ?? DEFAULT_THRESHOLD_MS;
  const slopPx = opts.slopPx ?? DEFAULT_SLOP_PX;
  const scheduler = opts.scheduler ?? realScheduler;
  const isDisabled = opts.isDisabled ?? (() => false);

  let state: LongPressState = LONG_PRESS_INITIAL;
  let timer: unknown = null;
  // Latched when a hold completes; consumed by the very next click so the
  // synthetic post-long-press click is swallowed and nothing else.
  let suppressClick = false;

  const clearTimer = () => {
    if (timer !== null) {
      scheduler.clear(timer);
      timer = null;
    }
  };
  const dispatch = (event: Parameters<typeof longPressReducer>[1]): LongPressState => {
    state = longPressReducer(state, event);
    return state;
  };

  return {
    onPointerDown: (e: PointerLike) => {
      if (isDisabled() || !isTouchLike(e.pointerType)) return;
      clearTimer();
      dispatch({ type: "down", x: e.clientX, y: e.clientY });
      timer = scheduler.set(() => {
        timer = null;
        const next = dispatch({ type: "timer" });
        if (shouldSuppressClick(next)) {
          suppressClick = true;
          opts.onLongPress();
        }
      }, thresholdMs);
    },
    onPointerMove: (e: PointerLike) => {
      if (state.phase !== "pressing") return;
      const next = dispatch({ type: "move", x: e.clientX, y: e.clientY, slop: slopPx });
      // A scroll past the slop cancels the pending hold (it never fired → no
      // click suppression).
      if (next.phase === "cancelled") clearTimer();
    },
    onPointerUp: () => {
      clearTimer();
      dispatch({ type: "up" });
    },
    onPointerLeave: () => {
      clearTimer();
      dispatch({ type: "up" });
    },
    onPointerCancel: () => {
      clearTimer();
      dispatch({ type: "cancel" });
    },
    onClickCapture: (e: ClickLike) => {
      // Swallow ONLY the synthetic click that follows a completed hold. A plain
      // tap never sets this latch, so the host's onClick fires normally.
      if (suppressClick) {
        suppressClick = false;
        e.preventDefault();
        e.stopPropagation();
      }
    },
    onContextMenu: (e: ClickLike) => {
      e.preventDefault();
    },
  };
}

export function useLongPress({
  onLongPress,
  thresholdMs = DEFAULT_THRESHOLD_MS,
  slopPx = DEFAULT_SLOP_PX,
  disabled = false,
}: UseLongPressOptions): LongPressHandlers {
  // Keep the latest callback + disabled flag in refs so the controller is built
  // once (stable handler identities) yet always sees current values.
  const onLongPressRef = useRef(onLongPress);
  onLongPressRef.current = onLongPress;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const controller = useMemo(
    () =>
      createLongPressController({
        onLongPress: () => onLongPressRef.current(),
        thresholdMs,
        slopPx,
        isDisabled: () => disabledRef.current,
      }),
    [thresholdMs, slopPx],
  );

  // Cancel any pending hold if the component unmounts mid-press.
  useEffect(() => () => controller.onPointerCancel(), [controller]);

  return controller;
}
