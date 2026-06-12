/**
 * Quote totals — pure, foundation-scope ONLY (#183).
 *
 * What this module does: sum the computed line totals → subtotal ex GST →
 * GST at a flat configurable rate → total inc GST. Nothing else.
 *
 * BOUNDARY WITH #214 (stated in the #172 ruling §8): the full legacy
 * pricing math — per-category material markup, labour cost modes
 * (per-line | shared), provisional sums, contingency %, fixed-price
 * override, internal margin (docs/quoting-legacy-audit.md §4.4) — is the
 * acceptance spec for the calculator children (#193/#195/#214/#223), NOT
 * for this foundation. None of that machinery may creep in here; #214
 * grows this module against the legacy `computeQuoteTotals` fixtures.
 *
 * ROUNDING RULE (pinned, tested): money is 2dp; **round at the line, then
 * sum**. Each line total is qty × rate rounded to cents; the subtotal is
 * the exact sum of those rounded line totals (re-rounded only to absorb
 * float drift); GST and the inc-GST total round once each. The rule means
 * the document always foots — the printed line totals add up to the
 * printed subtotal — at the cost of the subtotal differing from
 * round(Σ unrounded) by fractions of a cent in pathological cases.
 * Half-cent values round half-up toward +∞ (1.005 → 1.01).
 *
 * MIRROR: api/quotes-v2.js (CJS — cannot import TS) carries a hand-mirror
 * of these functions for the server-side snapshot. The golden fixtures in
 * totals.test.ts are duplicated in the API harness test so the two
 * implementations cannot drift silently. Change them TOGETHER.
 */

import type { QuoteTotals } from "./schema";

/** Australian GST. Configurable constant — never inline 0.1 at call sites. */
export const GST_RATE = 0.1;

/** Round to cents. EPSILON nudge so float artefacts like 2.675 → 267.49999…
 *  still round half-up; half-cents go toward +∞. */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** A line's total is COMPUTED, never stored: qty × rate, rounded to cents. */
export function lineTotal(line: { qty: number; rate: number }): number {
  return roundMoney(line.qty * line.rate);
}

interface SectionLike {
  lines: ReadonlyArray<{ qty: number; rate: number }>;
}

/** Sum of a section's rounded line totals (for per-section subtotals). */
export function sectionSubtotal(section: SectionLike): number {
  let sum = 0;
  for (const line of section.lines) sum += lineTotal(line);
  return roundMoney(sum);
}

/**
 * The quote-level totals snapshot. `gstRate` is parameterised for the
 * configurable-constant requirement; callers normally omit it.
 */
export function computeQuoteTotals(
  sections: ReadonlyArray<SectionLike>,
  gstRate: number = GST_RATE,
): QuoteTotals {
  let subtotal = 0;
  let lineCount = 0;
  for (const section of sections) {
    for (const line of section.lines) {
      subtotal += lineTotal(line);
      lineCount += 1;
    }
  }
  const subtotalExGst = roundMoney(subtotal);
  const gst = roundMoney(subtotalExGst * gstRate);
  const totalIncGst = roundMoney(subtotalExGst + gst);
  return { subtotalExGst, gst, totalIncGst, lineCount };
}

/** "$1,234.56" / "−$10.00" — one formatter so every surface prints money
 *  the same way (en-AU grouping, always 2dp). */
export function formatMoney(value: number): string {
  const abs = Math.abs(value).toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${value < 0 ? "−" : ""}$${abs}`;
}
