/**
 * Phil — pull-to-refresh decision logic (#149, slice 2).
 *
 * Pure helpers so the arm / threshold / suppression rules are unit-tested in
 * node with NO DOM and no touch events — the same shape as longPressReducer.
 * The component (PullToRefresh.tsx) is a thin shell that wires real touch
 * events + router.refresh() onto these.
 *
 * Constitution: a familiar refresh gesture under P10 (additive — the page still
 * works untouched without it) and P7 (it re-renders real server data; it never
 * stamps a fake "updated just now"). Suppression keeps the gesture from
 * fighting scroll, the capture flow, or a horizontal strip.
 *
 * Cross-ref:
 *   src/components/phil/PullToRefresh.tsx — the hook/component that drives this
 *   src/components/phil/longPressReducer.ts — the same pure-decision precedent
 */

/** Past this pull distance (px, after resistance) the release triggers a
 *  refresh and the spinner shows "ready". A deliberate pull, not a nudge. */
export const PTR_THRESHOLD_PX = 72;

/** Self-bounding budget (ms): the spinner ALWAYS resolves within this window —
 *  success or an honest "couldn't refresh" — so a stalled router.refresh()
 *  offline can never leave an infinite spinner. (#149 scope guard; does NOT
 *  depend on #139's shared helper, which is still open.) */
export const PTR_TIMEOUT_MS = 8000;

/**
 * Whether a touchstart may ARM the pull. The gesture only begins when the shared
 * scroll container is genuinely at the top AND nothing else owns the gesture —
 * a sheet/dialog, a non-empty capture tray, an in-flight submit, or a touch that
 * began inside a horizontal-scroll strip (tagged `data-no-ptr`). This is the one
 * decision the component asks per touchstart.
 */
export interface PtrArmInput {
  /** The shared scroll container's scrollTop. Arm only at the very top. */
  scrollTop: number;
  /** Any sheet/dialog is open — let it own the gesture, not the page. */
  sheetOpen: boolean;
  /** The capture launcher tray holds unsaved photos — never refresh under it. */
  trayNonEmpty: boolean;
  /** A submit is in flight somewhere — don't yank the tree out from under it. */
  submitInFlight: boolean;
  /** The touch started inside a horizontal-scroll strip (closest [data-no-ptr]). */
  insideNoPtr: boolean;
  /** A refresh is already running — don't start a second pull. */
  refreshing: boolean;
}

/** True only when every suppression is clear AND we're at scroll-top. */
export function canArmPull(input: PtrArmInput): boolean {
  if (input.sheetOpen) return false;
  if (input.trayNonEmpty) return false;
  if (input.submitInFlight) return false;
  if (input.insideNoPtr) return false;
  if (input.refreshing) return false;
  // scrollTop can be a sub-pixel negative on iOS rubber-band; treat <= 0 as top.
  return input.scrollTop <= 0;
}

/**
 * Apply rubber-band resistance to the raw finger travel so the indicator lags
 * the finger (native feel) and the threshold takes a deliberate pull. Only the
 * downward component matters; an upward drag yields 0 (the worker is scrolling,
 * not pulling). Pure + monotonic so it's directly assertable.
 */
export function pullDistance(rawDeltaY: number, resistance = 0.5): number {
  if (rawDeltaY <= 0) return 0;
  return rawDeltaY * resistance;
}

/** Has the (resisted) pull passed the trigger threshold? */
export function pullPastThreshold(distance: number, threshold = PTR_THRESHOLD_PX): boolean {
  return distance >= threshold;
}

/**
 * What a release should do, given the pull distance at release and whether the
 * gesture was ever armed. Pure so the release decision is node-testable.
 *
 *   not armed                  → "cancel" (we never owned this gesture)
 *   armed, past the threshold  → "refresh"
 *   armed, short of it         → "cancel" (snap back, no refresh)
 */
export function releaseDecision(
  armed: boolean,
  distance: number,
  threshold = PTR_THRESHOLD_PX,
): "refresh" | "cancel" {
  if (!armed) return "cancel";
  return pullPastThreshold(distance, threshold) ? "refresh" : "cancel";
}
