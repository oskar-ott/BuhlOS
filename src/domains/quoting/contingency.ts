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
 * amount IS the legacy contingency amount — never a second, drift-prone
 * implementation. The breakout always FOOTS: base + amount = subtotal.
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
  // Pre-contingency subtotal of sell (incl. provisional) — the named base.
  const base = round2(r.materials.sell + r.labour.sell + r.provisional.total);

  const fixed = opts?.amountExGst;
  if (fixed != null && Number.isFinite(Number(fixed))) {
    const amount = round2(Number(fixed));
    return {
      base,
      mode: "amount",
      pct: base > 0 ? round1((amount / base) * 100) : 0,
      amount,
      subtotalWithContingency: round2(base + amount),
      overriddenByFixedPrice: r.overridden,
    };
  }

  // Percent path — the legacy-native amount, surfaced as a deliberate line.
  return {
    base,
    mode: "percent",
    pct: r.contingency.pct,
    amount: r.contingency.amount,
    subtotalWithContingency: round2(base + r.contingency.amount),
    overriddenByFixedPrice: r.overridden,
  };
}
