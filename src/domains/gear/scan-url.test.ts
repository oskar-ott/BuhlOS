import { describe, expect, it } from "vitest";
import {
  SCAN_PATH,
  SCAN_KINDS,
  assetScanPath,
  assetScanUrl,
  parseScanQuery,
  isLiveScanKind,
} from "./scan-url";

describe("scan-url — the sacred /phil/gear/scan scheme (#303)", () => {
  it("keeps the sacred path frozen (printed stickers depend on it)", () => {
    // A change here breaks every label already stuck to a tool. This assertion
    // is the tripwire — if you must change it, you are minting a new sticker gen.
    expect(SCAN_PATH).toBe("/phil/gear/scan");
  });

  it("builds a relative asset scan path", () => {
    expect(assetScanPath("a_123")).toBe("/phil/gear/scan?asset=a_123");
  });

  it("url-encodes an id so an odd id can't break the query", () => {
    expect(assetScanPath("a b/c?x")).toBe("/phil/gear/scan?asset=a%20b%2Fc%3Fx");
  });

  it("builds an absolute scan URL from an origin, trimming a trailing slash", () => {
    expect(assetScanUrl("https://app.example.com", "a_9")).toBe(
      "https://app.example.com/phil/gear/scan?asset=a_9",
    );
    expect(assetScanUrl("https://app.example.com/", "a_9")).toBe(
      "https://app.example.com/phil/gear/scan?asset=a_9",
    );
  });

  it("reserves the #275 sibling namespaces (asset live; location/box reserved)", () => {
    expect(SCAN_KINDS).toEqual(["asset", "location", "box"]);
    expect(isLiveScanKind("asset")).toBe(true);
    expect(isLiveScanKind("location")).toBe(false);
    expect(isLiveScanKind("box")).toBe(false);
  });
});

describe("parseScanQuery", () => {
  it("parses an asset target from a plain record (Next searchParams)", () => {
    expect(parseScanQuery({ asset: "a_5" })).toEqual({ kind: "asset", id: "a_5" });
  });

  it("parses from URLSearchParams too", () => {
    expect(parseScanQuery(new URLSearchParams("asset=a_5"))).toEqual({
      kind: "asset",
      id: "a_5",
    });
  });

  it("recognises the reserved location/box kinds (so the page can say 'not built')", () => {
    expect(parseScanQuery({ location: "l_1" })).toEqual({ kind: "location", id: "l_1" });
    expect(parseScanQuery({ box: "b_1" })).toEqual({ kind: "box", id: "b_1" });
  });

  it("returns null for a non-BuhlOS QR (no recognised param)", () => {
    expect(parseScanQuery({ foo: "bar" })).toBeNull();
    expect(parseScanQuery({})).toBeNull();
  });

  it("treats an empty / whitespace id as absent (damaged sticker)", () => {
    expect(parseScanQuery({ asset: "" })).toBeNull();
    expect(parseScanQuery({ asset: "   " })).toBeNull();
  });

  it("trims a padded id", () => {
    expect(parseScanQuery({ asset: " a_5 " })).toEqual({ kind: "asset", id: "a_5" });
  });

  it("is deterministic on a multi-param URL (asset wins by SCAN_KINDS order)", () => {
    expect(parseScanQuery({ box: "b_1", asset: "a_1" })).toEqual({ kind: "asset", id: "a_1" });
  });

  it("takes the first value from an array param", () => {
    expect(parseScanQuery({ asset: ["a_1", "a_2"] })).toEqual({ kind: "asset", id: "a_1" });
  });
});
