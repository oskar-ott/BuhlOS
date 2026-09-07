import { describe, expect, it } from "vitest";
import {
  chromeHintValueFromCookieHeader,
  parseChromeHint,
  serializeChromeHint,
} from "./chrome-hint";

/**
 * The chrome-hint cookie codec behind the cold-start skeleton chrome
 * (chrome-hint.ts). The load-bearing property is STRICTNESS: the hint is a
 * client-writable cookie, so anything but the exact grammar must parse to
 * null — "no hint, render today's default chrome" — never a guess.
 */
describe("parseChromeHint / serializeChromeHint", () => {
  it("round-trips every valid baseline", () => {
    for (const hint of [
      { sharpened: false, jobRooms: false },
      { sharpened: true, jobRooms: false },
      { sharpened: true, jobRooms: true },
    ]) {
      expect(parseChromeHint(serializeChromeHint(hint))).toEqual(hint);
    }
  });

  it("enforces rooms-requires-sharpened, matching the server resolver", () => {
    // A hand-edited "rooms without sharpened" normalises rooms off…
    expect(parseChromeHint("s0.r1")).toEqual({ sharpened: false, jobRooms: false });
    // …and serialize never emits it.
    expect(serializeChromeHint({ sharpened: false, jobRooms: true })).toBe("s0.r0");
  });

  it("parses absent / empty / garbage to null (no hint)", () => {
    for (const raw of [
      undefined,
      null,
      "",
      "s1",
      "s1.r",
      "s2.r0",
      "s1.r0.x1",
      "sharpened",
      " s1.r0",
      "S1.R0",
      "s1%2Er0",
    ]) {
      expect(parseChromeHint(raw)).toBeNull();
    }
  });
});

describe("chromeHintValueFromCookieHeader", () => {
  it("finds the hint among other cookies, whatever the order/spacing", () => {
    expect(chromeHintValueFromCookieHeader("phil_chrome=s1.r0")).toBe("s1.r0");
    expect(
      chromeHintValueFromCookieHeader("buhl_session=abc; phil_chrome=s1.r1; other=x")
    ).toBe("s1.r1");
    expect(
      chromeHintValueFromCookieHeader("a=1;phil_chrome=s0.r0 ; b=2")
    ).toBe("s0.r0");
  });

  it("returns null when absent, empty, or only a look-alike name exists", () => {
    expect(chromeHintValueFromCookieHeader("")).toBeNull();
    expect(chromeHintValueFromCookieHeader(null)).toBeNull();
    expect(chromeHintValueFromCookieHeader("buhl_session=abc")).toBeNull();
    // The expired-cookie shape (value cleared) reads as no hint.
    expect(chromeHintValueFromCookieHeader("phil_chrome=; b=2")).toBeNull();
    // Name must match exactly — no prefix/suffix cousins.
    expect(chromeHintValueFromCookieHeader("phil_chrome_v2=s1.r0")).toBeNull();
    expect(chromeHintValueFromCookieHeader("x_phil_chrome=s1.r0")).toBeNull();
  });
});
