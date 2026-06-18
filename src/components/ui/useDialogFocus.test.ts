import { describe, expect, it } from "vitest";
import { resolveFocusTrapTarget } from "./useDialogFocus";

/**
 * Pure focus-trap decision (#521). The DOM wiring (scroll lock, restore, initial
 * focus) is preview-verified — the repo vitest env is node-only — but the
 * wrap/pull-back logic that keeps Tab inside the dialog is testable here.
 */
const F = ["a", "b", "c"];

describe("resolveFocusTrapTarget (#521)", () => {
  it("Tab on the last element wraps to the first", () => {
    expect(resolveFocusTrapTarget(F, "c", false)).toBe("a");
  });

  it("Tab in the middle lets the browser default move (null)", () => {
    expect(resolveFocusTrapTarget(F, "b", false)).toBeNull();
  });

  it("Tab when focus has ESCAPED the dialog pulls it back to the first", () => {
    expect(resolveFocusTrapTarget(F, "outside", false)).toBe("a");
    expect(resolveFocusTrapTarget(F, null, false)).toBe("a");
  });

  it("Shift+Tab on the first element wraps to the last", () => {
    expect(resolveFocusTrapTarget(F, "a", true)).toBe("c");
  });

  it("Shift+Tab in the middle lets the default move (null)", () => {
    expect(resolveFocusTrapTarget(F, "b", true)).toBeNull();
  });

  it("Shift+Tab when escaped pulls back to the last", () => {
    expect(resolveFocusTrapTarget(F, "outside", true)).toBe("c");
    expect(resolveFocusTrapTarget(F, null, true)).toBe("c");
  });

  it("an empty focusable set never moves focus", () => {
    expect(resolveFocusTrapTarget([], "a", false)).toBeNull();
    expect(resolveFocusTrapTarget([], null, true)).toBeNull();
  });

  it("a single focusable wraps to itself in both directions", () => {
    expect(resolveFocusTrapTarget(["only"], "only", false)).toBe("only");
    expect(resolveFocusTrapTarget(["only"], "only", true)).toBe("only");
  });
});
