import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createLongPressController } from "./useLongPress";

// PhilTabBar reads usePathname + useRouter (active tab + launcher deep-link);
// stub both for SSR, the same pattern as PhilTabBar.render.test.tsx.
vi.mock("next/navigation", () => ({
  usePathname: () => "/phil/my-day",
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { PhilTabBar } from "./PhilTabBar";

/**
 * #146 — the long-press FAB shortcut, driven as a real GESTURE (not just static
 * markup). The repo deliberately runs vitest in the `node` env with no jsdom, so
 * rather than render-and-fire-events we drive the SAME gesture engine the FAB
 * uses (`createLongPressController`, which `useLongPress` wraps) through its real
 * timer + reducer, and assert the FAB's tap-transparency wiring from the SSR
 * markup. Between them these lock the load-bearing guarantees:
 *
 *   1. A plain TAP fires the host's onClick (camera) and is NEVER suppressed —
 *      iOS needs the file-input click inside the user gesture.
 *   2. A completed HOLD calls onLongPress (opens the sheet) AND suppresses the
 *      single synthetic click that follows it.
 *   3. The FAB keeps its synchronous `onClick={onCapture}` and the global camera
 *      input, so the Preview-Smoke FAB case (fast click → Capture dialog) and
 *      the existing static render test pass unmodified.
 */

/** A pointerdown event the controller can read. */
const ptr = (over: Partial<{ pointerType: string; clientX: number; clientY: number }> = {}) => ({
  pointerType: "touch",
  clientX: 0,
  clientY: 0,
  ...over,
});
/** A click event that records whether it was suppressed. */
function clickEvent() {
  let suppressed = false;
  return {
    event: {
      preventDefault: () => {
        suppressed = true;
      },
      stopPropagation: () => {},
    },
    get suppressed() {
      return suppressed;
    },
  };
}

describe("PhilTabBar FAB — long-press gesture (real engine, fake timers)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a plain tap does NOT open the sheet and does NOT suppress the camera click", () => {
    const onLongPress = vi.fn();
    const c = createLongPressController({ onLongPress, thresholdMs: 450 });

    // Quick press → release well before the threshold (a tap).
    c.onPointerDown(ptr());
    vi.advanceTimersByTime(120);
    c.onPointerUp();
    vi.advanceTimersByTime(1000); // the timer was cleared — nothing more fires

    expect(onLongPress).not.toHaveBeenCalled();

    // The synthetic click that follows the tap must pass through (camera fires).
    const click = clickEvent();
    c.onClickCapture(click.event);
    expect(click.suppressed).toBe(false);
  });

  it("a completed hold opens the sheet (onLongPress) AND suppresses the next click", () => {
    const onLongPress = vi.fn();
    const c = createLongPressController({ onLongPress, thresholdMs: 450 });

    c.onPointerDown(ptr());
    vi.advanceTimersByTime(450); // cross the hold threshold
    expect(onLongPress).toHaveBeenCalledTimes(1);

    // The browser's synthetic post-hold click is swallowed (the sheet opened,
    // the FAB must not ALSO fire the camera).
    const click = clickEvent();
    c.onClickCapture(click.event);
    expect(click.suppressed).toBe(true);

    // ...and only that one click — a later, independent click is untouched.
    const next = clickEvent();
    c.onClickCapture(next.event);
    expect(next.suppressed).toBe(false);
  });

  it("a scroll past the slop cancels the hold (a list scroll never opens the sheet)", () => {
    const onLongPress = vi.fn();
    const c = createLongPressController({ onLongPress, thresholdMs: 450, slopPx: 10 });

    c.onPointerDown(ptr({ clientX: 0, clientY: 0 }));
    c.onPointerMove(ptr({ clientX: 0, clientY: 40 })); // dragged 40px → a scroll
    vi.advanceTimersByTime(450);

    expect(onLongPress).not.toHaveBeenCalled();
    const click = clickEvent();
    c.onClickCapture(click.event);
    expect(click.suppressed).toBe(false);
  });

  it("ignores a mouse pointer — long-press is a touch/pen gesture only", () => {
    const onLongPress = vi.fn();
    const c = createLongPressController({ onLongPress, thresholdMs: 450 });
    c.onPointerDown(ptr({ pointerType: "mouse" }));
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("respects `disabled` (no hold while a sheet is already open)", () => {
    const onLongPress = vi.fn();
    const c = createLongPressController({ onLongPress, thresholdMs: 450, isDisabled: () => true });
    c.onPointerDown(ptr());
    vi.advanceTimersByTime(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });
});

describe("PhilTabBar FAB — tap-transparency wiring (SSR markup)", () => {
  const html = renderToString(
    createElement(PhilTabBar, { userId: "u1" }),
  );

  it("still renders the named Capture FAB and the synchronous global camera input", () => {
    // The smoke + static render tests depend on these exact markers.
    expect(html).toContain('aria-label="Capture"');
    expect(html).toContain('type="file"');
    expect(html).toContain('capture="environment"');
  });

  it("blocks the OS callout on the FAB so the hold isn't hijacked", () => {
    // The FAB carries the -webkit-touch-callout:none utility class so the OS
    // selection / callout menu can't steal the hold.
    expect(html).toContain("[-webkit-touch-callout:none]");
  });

  it("keeps the launcher + the recents sheet closed until acted on (no always-open modal)", () => {
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("Capture into a recent job");
  });
});
