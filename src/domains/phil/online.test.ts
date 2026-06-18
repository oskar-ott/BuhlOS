import { afterEach, describe, expect, it, vi } from "vitest";

import { isOnline, subscribeOnline } from "./online";

/**
 * Online/offline detection (#139). Runs in the node env; the browser globals
 * are stubbed via vi.stubGlobal (no jsdom dependency).
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isOnline", () => {
  it("is true when navigator.onLine is true", () => {
    vi.stubGlobal("navigator", { onLine: true });
    expect(isOnline()).toBe(true);
  });

  it("is false only when navigator.onLine is explicitly false", () => {
    vi.stubGlobal("navigator", { onLine: false });
    expect(isOnline()).toBe(false);
  });

  it("treats unknown (undefined onLine) as online", () => {
    vi.stubGlobal("navigator", { onLine: undefined });
    expect(isOnline()).toBe(true);
  });

  it("treats a missing navigator (SSR) as online", () => {
    vi.stubGlobal("navigator", undefined);
    expect(isOnline()).toBe(true);
  });
});

describe("subscribeOnline", () => {
  it("fires true on 'online' and false on 'offline', and unsubscribes cleanly", () => {
    const fakeWindow = new EventTarget();
    vi.stubGlobal("window", fakeWindow);

    const seen: boolean[] = [];
    const unsubscribe = subscribeOnline((v) => seen.push(v));

    fakeWindow.dispatchEvent(new Event("offline"));
    fakeWindow.dispatchEvent(new Event("online"));
    expect(seen).toEqual([false, true]);

    unsubscribe();
    fakeWindow.dispatchEvent(new Event("offline"));
    expect(seen).toEqual([false, true]); // no further events after unsubscribe
  });

  it("is a no-op (returns a cleanup) when there is no window", () => {
    vi.stubGlobal("window", undefined);
    const unsubscribe = subscribeOnline(() => {
      throw new Error("should not be called");
    });
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
  });
});
