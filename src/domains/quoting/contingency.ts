import { computeQuoteMargin } from "./margin";
import type { QuoteMarginInput } from "./margin";

/**
 * Deliberate quote contingency (#223) — pure, no I/O.
 *
 * Legacy folds contingency silently INTO the subtotal (`contingencyPct` only).
 * This module breaks it out as a deliberate line so the office decides it on
 * purpose: a % (legacy-native) OR a fixed $ amount, over the named base
 * (subtotal-of-sell incl. provisional sums, before contingency).
 *
 * ONE number source: it delegates to `computeQuoteMargin` (margin.ts, the #214
 * port that is byte-parity with the legacy `computeQuoteTotals`), so the % path's
 * amount AND subtotal are the legacy figures — never a second, drift-prone
 * implementation. Footing: the % path (no fixed-price override) and the $ path
 * both FOOT exactly (base + amount = subtotal), and the % subtotal equals the
 * legacy quote subtotal; with a fixed-price override the override IS the subtotal
 * and the contingency is informational (so base + amount need not equal it).
 *
 * Deferred (touch hot/feature files, not this slice): per-section contingency
 * override, the client-presentation choice (needs #186's projection), and the
 * builder UI.
 */

export type ContingencyMode = "percent" | "amount";

export interface QuoteContingency {
  /** Subtotal of SELL (materials + labour + provisional) BEFORE contingency. */
  base: number;
  mode: ContingencyMode;
  /** The % applied. For `amount` mode this is the informational effective %. */
  pct: number;
  /** The contingency $ (ex GST). */
  amount: number;
  /** base + amount (ex GST). */
  subtotalWithContingency: number;
  /** True when the quote has a fixed-price override (overrideTotalExGst): the
   *  contingency is then INFORMATIONAL — the override replaces the subtotal. */
  overriddenByFixedPrice: boolean;
}

const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;
const round1 = (n: number): number => Math.round((Number(n) || 0) * 10) / 10;

/**
 * Compute the deliberate contingency breakout for a quote. Default (no opts) is
 * the legacy-native % path (the quote's `pricing.contingencyPct`). Pass
 * `{ amountExGst }` for a deliberate fixed-$ contingency instead — its
 * informational `pct` is derived from the base.
 */
export function computeQuoteContingency(
  input: QuoteMarginInput,
  opts?: { amountExGst?: number | null },
): QuoteContingency {
  const r = computeQuoteMargin(input);
  // Pre-contingency subtotal of sell (incl. provisional), from the rounded sell
  // components — the natural base for the $ path and the override case.
  const sellBase = round2(r.materials.sell + r.labour.sell + r.provisional.total);

  const fixed = opts?.amountExGst;
  if (fixed != null && Number.isFinite(Number(fixed))) {
    // Fixed-$ path (new, no legacy equivalent). base + amount are both 2dp, so
    // round2(base + amount) === base + amount → it foots exactly by construction.
    const amount = round2(Number(fixed));
    return {
      base: sellBase,
      mode: "amount",
      pct: sellBase > 0 ? round1((amount / sellBase) * 100) : 0,
      amount,
      subtotalWithContingency: round2(sellBase + amount),
      overriddenByFixedPrice: r.overridden,
    };
  }

  // Percent path — the legacy-native line. Take the amount AND the subtotal from
  // the oracle (computeQuoteMargin = sum-then-round off unrounded accumulators),
  // then derive base = subtotal - amount. This FOOTS exactly (both are 2dp, so
  // base + amount === subtotal) AND the subtotal equals the legacy quote subtotal
  // — avoiding the round-then-sum cent-drift that round2(sellBase + amount) would
  // introduce on sub-cent quotes (the artifact margin.ts warns against). When a
  // fixed-price override is in force, the override IS the subtotal and the
  // contingency is informational, so base stays the real pre-contingency sell
  // subtotal (and base + amount need not equal the override).
  const amount = r.contingency.amount;
  const subtotalWithContingency = r.subtotalExGst;
  const base = r.overridden ? sellBase : round2(subtotalWithContingency - amount);
  return {
    base,
    mode: "percent",
    pct: r.contingency.pct,
    amount,
    subtotalWithContingency,
    overriddenByFixedPrice: r.overridden,
  };
}
