/**
 * Low-light luminance helpers for the Phil capture flow.
 *
 * The capture sheet already downscales every shot client-side
 * (`resizeImageWithMeta` in service.ts). While that canvas is in hand we take
 * ONE average-luma reading (Rec.601) and, if it's below a unit-tested cutoff,
 * the tray/preview shows a NON-BLOCKING "bit dark" hint so the worker can
 * retake with the flash. The shutter is never gated on this — it is an additive
 * review nudge only (Phil constitution P10).
 *
 * The cutoff lives here, as a single named constant with its own test, so it is
 * never a magic number buried in a component. `avgLuma` is a real measured 0–255
 * value off the worker's photo — no invented score (P7).
 *
 * Pure: no DOM, no React, no canvas. The measurement (one getImageData pass)
 * happens in service.ts; this file only owns the threshold + the boolean.
 */

/**
 * Average-luma cutoff (0–255) under which a photo is flagged "low light".
 *
 * Picked conservatively so it only fires on genuinely dark frames (dim
 * subfloors, unlit risers), not merely moody or evenly-mid-grey shots — a
 * false "too dark" on a usable photo would train workers to ignore the hint.
 * ~52/255 (≈20% of full scale) sits below a normally-exposed indoor frame but
 * above a flash-needed dark one. Tuned by unit test, not by feel; adjust here
 * (one place) with a test if field evidence says it's too eager or too shy.
 */
export const LOW_LIGHT_LUMA_THRESHOLD = 52;

/**
 * True when a photo's measured average luma is low enough to warrant the
 * non-blocking "bit dark — try the flash" review hint.
 *
 * Honest about unknowns: a null/undefined/NaN reading (measurement skipped or
 * unavailable) is NOT treated as low light — we never show the hint on a guess.
 * Equal-to-threshold is treated as fine (strictly below fires).
 */
export function isLowLight(avgLuma: number | null | undefined): boolean {
  if (typeof avgLuma !== "number" || !Number.isFinite(avgLuma)) return false;
  return avgLuma < LOW_LIGHT_LUMA_THRESHOLD;
}
