/**
 * A barcode scanner plugged in or paired as a keyboard (owner, 2026-11-03: "i
 * bought a barcode scanner"). It "types" the code very fast and presses Enter.
 * This tells that apart from a person typing: every key of a scan arrives
 * within a few milliseconds of the last, a person's don't. Pure — the timing is
 * passed in, so it can be tested.
 */

/** Keys further apart than this aren't the scanner (a fast typist is ~80 ms+). */
export const SCAN_MAX_GAP_MS = 50;
/** Shorter than this isn't a product code (EAN-8 is the shortest common one). */
export const SCAN_MIN_LENGTH = 6;

export interface ScanDetector {
  /** Feed one keydown (its `key` and time in ms). Returns the code when a scan just ended, else null. */
  key(key: string, at: number): string | null;
}

export function createScanDetector({ maxGapMs = SCAN_MAX_GAP_MS, minLength = SCAN_MIN_LENGTH } = {}): ScanDetector {
  let buf = "";
  let last = -Infinity;
  return {
    key(key, at) {
      if (key === "Enter" || key === "Tab") {
        const code = at - last <= maxGapMs * 4 ? buf.trim() : "";
        buf = "";
        last = -Infinity;
        return code.length >= minLength ? code : null;
      }
      if (key.length !== 1) return null; // Shift and friends: not part of the code
      if (at - last > maxGapMs) buf = ""; // a pause: a person, or a new scan
      buf += key;
      last = at;
      return null;
    },
  };
}
