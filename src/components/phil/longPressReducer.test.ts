import { describe, expect, it } from "vitest";
import {
  exceedsSlop,
  longPressReducer,
  shouldSuppressClick,
  LONG_PRESS_INITIAL,
  type LongPressState,
} from "./longPressReducer";

/**
 * The pure long-press state machine (#146). These cover the load-bearing
 * guarantees with no DOM and no timers:
 *   - a hold (down → timer) fires and arms click-suppression;
 *   - a tap (down → up) passes through (cancelled, NOT fired, NO suppression);
 *   - a scroll past the slop cancels the pending hold;
 *   - a system cancel cancels.
 */

const down = (x = 0, y = 0): LongPressState =>
  longPressReducer(LONG_PRESS_INITIAL, { type: "down", x, y });

describe("longPressReducer", () => {
  it("starts idle with no origin", () => {
    expect(LONG_PRESS_INITIAL).toEqual({ phase: "idle", origin: null });
  });

  it("down → pressing and remembers the origin", () => {
    expect(down(12, 34)).toEqual({ phase: "pressing", origin: { x: 12, y: 34 } });
  });

  it("a completed hold: down → timer → fired (suppresses the next click)", () => {
    const pressing = down();
    const fired = longPressReducer(pressing, { type: "timer" });
    expect(fired.phase).toBe("fired");
    expect(shouldSuppressClick(fired)).toBe(true);
  });

  it("a tap: down → up → cancelled, never fired, NEVER suppresses the click", () => {
    const pressing = down();
    const cancelled = longPressReducer(pressing, { type: "up" });
    expect(cancelled.phase).toBe("cancelled");
    // The load-bearing rule: a tap must pass through so the FAB camera fires.
    expect(shouldSuppressClick(cancelled)).toBe(false);
  });

  it("a scroll past the slop cancels the pending hold", () => {
    const pressing = down(0, 0);
    const moved = longPressReducer(pressing, { type: "move", x: 0, y: 50, slop: 10 });
    expect(moved.phase).toBe("cancelled");
    expect(shouldSuppressClick(moved)).toBe(false);
  });

  it("a tiny jitter WITHIN the slop keeps pressing (a steady hold, not a scroll)", () => {
    const pressing = down(0, 0);
    const stillPressing = longPressReducer(pressing, { type: "move", x: 3, y: 4, slop: 10 });
    expect(stillPressing.phase).toBe("pressing");
    // exactly on the radius is NOT past it (strict >)
    const onRadius = longPressReducer(pressing, { type: "move", x: 6, y: 8, slop: 10 });
    expect(onRadius.phase).toBe("pressing");
  });

  it("timer after the press ended (up-first) does NOT fire (no late hold)", () => {
    const pressing = down();
    const cancelled = longPressReducer(pressing, { type: "up" });
    const late = longPressReducer(cancelled, { type: "timer" });
    expect(late.phase).toBe("cancelled");
    expect(shouldSuppressClick(late)).toBe(false);
  });

  it("system cancel while pressing → cancelled (no fire, no suppression)", () => {
    const pressing = down();
    const cancelled = longPressReducer(pressing, { type: "cancel" });
    expect(cancelled.phase).toBe("cancelled");
    expect(shouldSuppressClick(cancelled)).toBe(false);
  });

  it("up after a fired hold returns to idle (suppression already armed off `fired`)", () => {
    const fired = longPressReducer(down(), { type: "timer" });
    const idle = longPressReducer(fired, { type: "up" });
    expect(idle).toEqual(LONG_PRESS_INITIAL);
  });

  it("a fresh down restarts the machine from any terminal state", () => {
    const fired = longPressReducer(down(), { type: "timer" });
    const restarted = longPressReducer(fired, { type: "down", x: 5, y: 5 });
    expect(restarted).toEqual({ phase: "pressing", origin: { x: 5, y: 5 } });
  });

  it("reset returns to the initial state", () => {
    const fired = longPressReducer(down(), { type: "timer" });
    expect(longPressReducer(fired, { type: "reset" })).toEqual(LONG_PRESS_INITIAL);
  });

  it("move/cancel are no-ops from idle (defensive — never throws)", () => {
    expect(longPressReducer(LONG_PRESS_INITIAL, { type: "move", x: 1, y: 1, slop: 5 })).toEqual(
      LONG_PRESS_INITIAL,
    );
    expect(longPressReducer(LONG_PRESS_INITIAL, { type: "cancel" })).toEqual(LONG_PRESS_INITIAL);
  });
});

describe("exceedsSlop", () => {
  it("is false with no origin (off-press)", () => {
    expect(exceedsSlop(null, 100, 100, 10)).toBe(false);
  });
  it("uses radial (not axis) distance", () => {
    // dx=8, dy=8 → dist² = 128 > 10² = 100
    expect(exceedsSlop({ x: 0, y: 0 }, 8, 8, 10)).toBe(true);
    // dx=6, dy=8 → dist² = 100, exactly on the radius, NOT past
    expect(exceedsSlop({ x: 0, y: 0 }, 6, 8, 10)).toBe(false);
  });
});
