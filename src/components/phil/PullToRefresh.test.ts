import { describe, expect, it } from "vitest";
import {
  canArmPull,
  pullDistance,
  pullPastThreshold,
  releaseDecision,
  PTR_THRESHOLD_PX,
  PTR_TIMEOUT_MS,
  type PtrArmInput,
} from "./pullToRefreshLogic";

/**
 * The pure pull-to-refresh decision logic (#149, slice 2). Node-only, no DOM —
 * the test-infra the issue mandates. Covers: armed ONLY at scrollTop 0; every
 * suppression flag blocks the arm; the resistance + threshold; and the release
 * decision (refresh past the threshold, snap back short of it).
 */

const clear: PtrArmInput = {
  scrollTop: 0,
  sheetOpen: false,
  trayNonEmpty: false,
  submitInFlight: false,
  insideNoPtr: false,
  refreshing: false,
};

describe("canArmPull — arm only at the top, with no competing gesture", () => {
  it("arms when at scroll-top and nothing is suppressing", () => {
    expect(canArmPull(clear)).toBe(true);
  });

  it("does NOT arm when the container is scrolled down", () => {
    expect(canArmPull({ ...clear, scrollTop: 1 })).toBe(false);
    expect(canArmPull({ ...clear, scrollTop: 200 })).toBe(false);
  });

  it("treats a sub-pixel rubber-band negative scrollTop as the top", () => {
    expect(canArmPull({ ...clear, scrollTop: -0.5 })).toBe(true);
  });

  it("is suppressed when a sheet/dialog is open", () => {
    expect(canArmPull({ ...clear, sheetOpen: true })).toBe(false);
  });

  it("is suppressed when the capture tray holds unsaved photos", () => {
    expect(canArmPull({ ...clear, trayNonEmpty: true })).toBe(false);
  });

  it("is suppressed while a submit is in flight", () => {
    expect(canArmPull({ ...clear, submitInFlight: true })).toBe(false);
  });

  it("is suppressed when the touch began inside a horizontal-scroll strip", () => {
    expect(canArmPull({ ...clear, insideNoPtr: true })).toBe(false);
  });

  it("is suppressed while a refresh is already running", () => {
    expect(canArmPull({ ...clear, refreshing: true })).toBe(false);
  });

  it("any single suppression flag is enough to block the arm", () => {
    const flags: (keyof PtrArmInput)[] = [
      "sheetOpen",
      "trayNonEmpty",
      "submitInFlight",
      "insideNoPtr",
      "refreshing",
    ];
    for (const f of flags) {
      expect(canArmPull({ ...clear, [f]: true })).toBe(false);
    }
  });
});

describe("pullDistance — rubber-band resistance", () => {
  it("returns 0 for an upward drag (that's a scroll, not a pull)", () => {
    expect(pullDistance(-40)).toBe(0);
    expect(pullDistance(0)).toBe(0);
  });

  it("applies resistance so the indicator lags the finger", () => {
    expect(pullDistance(100, 0.5)).toBe(50);
    expect(pullDistance(80, 0.5)).toBe(40);
  });

  it("is monotonic — pulling further never moves the indicator backward", () => {
    expect(pullDistance(120)).toBeGreaterThan(pullDistance(100));
  });
});

describe("pullPastThreshold", () => {
  it("is false short of the threshold and true at/over it", () => {
    expect(pullPastThreshold(PTR_THRESHOLD_PX - 1)).toBe(false);
    expect(pullPastThreshold(PTR_THRESHOLD_PX)).toBe(true);
    expect(pullPastThreshold(PTR_THRESHOLD_PX + 50)).toBe(true);
  });
});

describe("releaseDecision", () => {
  it("refreshes when armed and pulled past the threshold", () => {
    expect(releaseDecision(true, PTR_THRESHOLD_PX + 10)).toBe("refresh");
  });

  it("cancels (snaps back) when armed but short of the threshold", () => {
    expect(releaseDecision(true, PTR_THRESHOLD_PX - 10)).toBe("cancel");
  });

  it("cancels when never armed, regardless of distance", () => {
    expect(releaseDecision(false, PTR_THRESHOLD_PX + 999)).toBe("cancel");
  });
});

describe("self-bounding budget", () => {
  it("has a fixed finite timeout so the spinner always resolves (never infinite)", () => {
    expect(PTR_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(PTR_TIMEOUT_MS)).toBe(true);
  });
});
