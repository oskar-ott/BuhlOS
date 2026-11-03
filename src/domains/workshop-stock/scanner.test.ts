import { describe, expect, it } from "vitest";
import { createScanDetector } from "./scanner";

/** Feed a string as keydowns `gap` ms apart, then Enter `gap` ms later. */
function feed(d: ReturnType<typeof createScanDetector>, text: string, gap: number, start = 1000): string | null {
  let t = start;
  for (const ch of text) { d.key(ch, t); t += gap; }
  return d.key("Enter", t);
}

describe("barcode scanner (keyboard-style) vs a person typing", () => {
  it("a scan — every key within a few ms, then Enter — is the code", () => {
    expect(feed(createScanDetector(), "9338475023035", 4)).toBe("9338475023035");
  });

  it("a person typing the same digits is not a scan", () => {
    expect(feed(createScanDetector(), "9338475023035", 140)).toBeNull();
  });

  it("too short isn't a product code; Shift and other named keys aren't part of it", () => {
    expect(feed(createScanDetector(), "12345", 3)).toBeNull();
    const d = createScanDetector();
    d.key("Shift", 1000);
    expect(feed(d, "ABC-12345", 3, 1001)).toBe("ABC-12345");
  });

  it("a slow key before a scan doesn't stick to it; a late Enter isn't a scan", () => {
    const d = createScanDetector();
    d.key("x", 0);
    expect(feed(d, "40063813339", 3, 2000)).toBe("40063813339");
    const late = createScanDetector();
    for (const [i, ch] of [..."40063813339"].entries()) late.key(ch, 5000 + i * 3);
    expect(late.key("Enter", 9000)).toBeNull();
  });
});
