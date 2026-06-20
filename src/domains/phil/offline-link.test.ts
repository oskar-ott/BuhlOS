import { describe, expect, it } from "vitest";

import { decidePhilLinkNavigation, type PhilLinkClick } from "./offline-link";

// A plain, primary-button, same-tab click of a string href — the only shape
// PhilOfflineLink ever intercepts. Each test overrides one field.
function click(over: Partial<PhilLinkClick> = {}): PhilLinkClick {
  return {
    online: true,
    hrefIsString: true,
    modifierKey: false,
    primaryButton: true,
    defaultPrevented: false,
    selfTarget: true,
    ...over,
  };
}

describe("decidePhilLinkNavigation", () => {
  it("online plain click → soft-warm (let Next soft-nav, warm the cache)", () => {
    expect(decidePhilLinkNavigation(click({ online: true }))).toBe("soft-warm");
  });

  it("offline plain click → hard-navigate (force a document nav the SW can serve)", () => {
    expect(decidePhilLinkNavigation(click({ online: false }))).toBe("hard-navigate");
  });

  it("leaves modified clicks to the browser, even offline (new tab / cmd-click)", () => {
    expect(decidePhilLinkNavigation(click({ modifierKey: true, online: false }))).toBe(
      "browser-default",
    );
  });

  it("leaves non-primary-button clicks to the browser (middle-click)", () => {
    expect(decidePhilLinkNavigation(click({ primaryButton: false, online: false }))).toBe(
      "browser-default",
    );
  });

  it("leaves non-_self targets to the browser", () => {
    expect(decidePhilLinkNavigation(click({ selfTarget: false, online: false }))).toBe(
      "browser-default",
    );
  });

  it("leaves object (non-string) hrefs to Next/the browser", () => {
    expect(decidePhilLinkNavigation(click({ hrefIsString: false, online: false }))).toBe(
      "browser-default",
    );
  });

  it("respects a prior preventDefault (another handler already took it)", () => {
    expect(decidePhilLinkNavigation(click({ defaultPrevented: true, online: false }))).toBe(
      "browser-default",
    );
  });
});
