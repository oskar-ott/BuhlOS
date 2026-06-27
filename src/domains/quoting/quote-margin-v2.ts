/**
 * Sell-side quote margin (#214/#193) — pure, for the v2 quote model.
 *
 * The v2 quote is SELL-SIDE: a line's `rate` IS the sell rate (totals.ts:
 * sell = qty × rate). #214 adds an optional INTERNAL `unitCost` per line
 * (for a labour line a rate preset fills it with the loaded cost rate), and
 * this module derives the office-only margin DIRECTLY:
 *     line sell = qty × rate      (totals.ts, unchanged — drives the client doc)
 *     line cost = qty × unitCost  (only when a cost is present)
 *     margin    = sell − cost
 *
 * This deliberately does NOT use margin.ts's legacy markup-derived pipeline
 * (that derives sell from cost × markup and is parity-locked to the legacy
 * rate model). The v2 foundation enters sell directly, so margin is the direct
 * sell − cost; we reuse only margin.ts's MarginFlag vocabulary + threshold.
 *
 * HONESTY (P7): a line with no `unitCost` is UNCOSTED — never counted as $0
 * cost (which would fake a 100% margin). A section/rollup is `complete` only
 * when every line is costed; while incomplete, `margin.pct` is null and the
 * UI shows "N of M costed", never a green margin.
 *
 * INTERNAL-ONLY: this module's output (cost/margin/flag) is office-only and
 * must never reach a client view — the client projection (#186,
 * client-projection.ts) is an explicit sell-side allowlist, so nothing here
 * can ride along to a customer.
 */

import { lineTotal, roundMoney } from "./totals";
import { DEFAULT_LOW_MARGIN_THRESHOLD_PCT, type MarginFlag } from "./margin";

const round1 = (n: number): number => Math.round((Number(n) || 0) * 10) / 10;

/** The line fields this module reads (a structural subset of QuoteLine). */
export interface V2MarginLine {
  qty: number;
  rate: number;
  unitCost?: number | null;
}
export interface V2MarginSectionInput {
  id?: string;
  title?: string;
  lines: ReadonlyArray<V2MarginLine>;
}

export interface V2MarginRow {
  id: string;
  title: string;
  sell: number;
  /** Sum of costed lines' cost. Partial when uncostedLineCount > 0. */
  cost: number;
  lineCount: number;
  costedLineCount: number;
  uncostedLineCount: number;
  /** True when every line carries a cost (so margin is trustworthy). */
  complete: boolean;
  margin: {
    /** round2(sell − cost) over the COSTED portion. */
    amount: number;
    /** round1 percent — null when incomplete or sell is 0 (UI renders "—"). */
    pct: number | null;
  };
  /** Health flag — only meaningful when `complete`; the UI shows a neutral
   *  "partial" treatment otherwise (never a green/ok on incomplete data). */
  flag: MarginFlag;
}

export interface V2QuoteMargin {
  sections: V2MarginRow[];
  rollup: V2MarginRow;
}

export interface V2MarginOptions {
  /** Below this %, a positive margin flags `low`. Default 15. A loss is
   *  `negative` first. */
  lowMarginThresholdPct?: number;
}

function lineHasCost(l: V2MarginLine): boolean {
  return typeof l.unitCost === "number" && Number.isFinite(l.unitCost);
}

function lineSell(l: V2MarginLine): number {
  return lineTotal({ qty: Number(l.qty) || 0, rate: Number(l.rate) || 0 });
}

function lineCost(l: V2MarginLine): number {
  return roundMoney((Number(l.qty) || 0) * (Number(l.unitCost) || 0));
}

/** Flag from an UNROUNDED amount + pct. Mirrors margin.ts's classifyFlag rule
 *  (kept local so this module never depends on margin.ts internals): a loss is
 *  `negative` (checked first); a 0-sell row with no loss is `ok`; a positive
 *  margin below the threshold is `low`. */
function flagFor(amount: number, pct: number | null, threshold: number): MarginFlag {
  if (amount < 0) return "negative";
  if (pct === null) return "ok";
  if (pct < threshold) return "low";
  return "ok";
}

function rowFrom(
  id: string,
  title: string,
  lines: ReadonlyArray<V2MarginLine>,
  threshold: number,
): V2MarginRow {
  let sell = 0;
  let cost = 0;
  let costedLineCount = 0;
  for (const l of lines) {
    sell += lineSell(l);
    if (lineHasCost(l)) {
      cost += lineCost(l);
      costedLineCount += 1;
    }
  }
  sell = roundMoney(sell);
  cost = roundMoney(cost);
  const lineCount = lines.length;
  const uncostedLineCount = lineCount - costedLineCount;
  const complete = uncostedLineCount === 0;
  const amount = roundMoney(sell - cost);
  // pct is only honest when every line is costed (and there's a sell to divide
  // by). Incomplete → null so the UI shows "N of M costed", never a margin %.
  const rawPct = complete && sell > 0 ? ((sell - cost) / sell) * 100 : null;
  const pct = rawPct === null ? null : round1(rawPct);
  // Flag only carries a health colour when complete; an incomplete row is shown
  // neutrally by the panel regardless, but we force 'ok' (not a false 'low'/'negative').
  const flag = complete ? flagFor(sell - cost, rawPct, threshold) : "ok";
  return {
    id,
    title,
    sell,
    cost,
    lineCount,
    costedLineCount,
    uncostedLineCount,
    complete,
    margin: { amount, pct },
    flag,
  };
}

/**
 * Per-section + rollup sell/cost/margin for a v2 quote. Pure. The rollup is
 * computed over ALL lines (not summed from rounded section rows) so it never
 * disagrees with itself by a rounding cent.
 */
export function computeV2QuoteMargin(
  quote: { sections: ReadonlyArray<V2MarginSectionInput> },
  options: V2MarginOptions = {},
): V2QuoteMargin {
  const threshold = options.lowMarginThresholdPct ?? DEFAULT_LOW_MARGIN_THRESHOLD_PCT;
  const sections = quote.sections.map((s, i) =>
    rowFrom(s.id ?? `section:${i}`, s.title ?? `Section ${i + 1}`, s.lines, threshold),
  );
  const allLines = quote.sections.flatMap((s) => s.lines);
  const rollup = rowFrom("quote", "Quote total", allLines, threshold);
  return { sections, rollup };
}
