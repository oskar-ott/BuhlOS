import type { QuoteMaterialItem, MaterialBreakdownRow } from "./margin";

/**
 * Material calculator — pure, dependency-free (#195).
 *
 * THE MATERIALS HALF OF THE PARITY ORACLE. The material math (per-line cost with
 * the legacy falsy-OR precedence, per-category markup → sell, the per-category
 * breakdown) lives in legacy `api/quotes.js` `computeQuoteTotals` (the materials
 * loop, ~lines 802-818) and is also encoded inside `margin.ts` (#214). This
 * module extracts it as a standalone, reusable unit — the same role
 * `labour-calc.ts` (#193) plays for the labour loop — so the v2 builder's
 * materials section can compute material cost/sell/breakdown WITHOUT running the
 * whole margin pipeline. Ported VERBATIM; `material-calc.test.ts` runs the same
 * fixtures through the LIVE legacy `computeQuoteTotals` and asserts the
 * `.materials` block is byte-identical.
 *
 * LEGACY FORMULA (per material line `m`, markup table `markupTbl`):
 *   qty       = Number(m.quantity) || 0
 *   lineCost  = (m.totalCost != null && Number(m.totalCost))
 *                 || (m.unitCost != null ? Number(m.unitCost) * qty : 0)
 *   if (!isFinite(lineCost)) skip the line entirely
 *   cat       = String(m.category || 'Other')
 *   markup    = (markupTbl[cat] != null) ? Number(markupTbl[cat]) : defaultMarkup
 *   lineSell  = lineCost * (1 + markup / 100)
 *   accumulate matCost, matSell + per-category {cost, sell, count, markupPct}
 * Output: cost=round2(Σcost), sell=round2(Σsell), breakdown rows round2'd, in
 * first-seen category order.
 *
 * PARITY-CRITICAL DETAILS (do not "fix"):
 *   - `(m.totalCost != null && Number(m.totalCost)) || …` keeps its falsy
 *     precedence: a `totalCost` of 0 (or NaN) is falsy → falls through to
 *     `unitCost*qty`. Replicated exactly.
 *   - A non-finite `lineCost` SKIPS the line (it never enters matCost/breakdown).
 *   - `String(m.category || 'Other')` — empty/null/0 category → 'Other'.
 *   - Negative category markup is allowed (PATCH permits −50%).
 *   - First-seen `markupPct` per category is stamped and never overwritten.
 *   - matCost/matSell accumulate UNROUNDED; round2 ONCE at output (and per
 *     breakdown row). Do NOT round per line then sum — it drifts from legacy.
 *   - `unpricedCount` is ADDITIVE honesty (#195 spirit) and NEVER changes a
 *     number: it counts lines with no usable price (no truthy/finite totalCost
 *     AND no unitCost) — legacy already books 0 cost for those via the falsy-OR,
 *     we add the flag, not a fake $0.
 */

/** Pricing settings that drive the material math — the legacy
 *  PRICING_DEFAULTS subset `{ materialMarkupPct }`. */
export interface MaterialCalcSettings {
  /** Per-category markup %; `default` is the fallback. Negative allowed.
   *  Missing → `{ default: 25 }` (the legacy default table). */
  materialMarkupPct?: Record<string, number> | null;
}

/** Standard defaults — mirror api/quotes.js PRICING_DEFAULTS (materials subset). */
export const MATERIAL_CALC_DEFAULTS: MaterialCalcSettings = {
  materialMarkupPct: { default: 25 },
};

/** Per-line computed result for DISPLAY (rounded). Section totals re-sum the
 *  UNROUNDED contributions internally (legacy parity), so never sum these. */
export interface MaterialLineResult {
  /** Resolved category (`m.category || 'Other'`). */
  category: string;
  /** lineCost (round2 for display). */
  cost: number;
  /** lineSell = lineCost·(1+markup/100) (round2 for display). */
  sell: number;
  /** The markup % applied to this line's category. */
  markupPct: number;
  /** True when the line has no usable price (no truthy/finite totalCost AND no
   *  unitCost). Additive honesty — the line still contributes its (zero) cost. */
  unpriced: boolean;
  /** True when lineCost is non-finite — legacy SKIPS such a line from totals. */
  skipped: boolean;
}

/** Materials section totals — the legacy `materials` block plus an additive
 *  `unpricedCount`. The `{ cost, sell, breakdown }` here equals legacy
 *  `computeQuoteTotals(...).materials` byte-for-byte. */
export interface MaterialTotals {
  cost: number;
  sell: number;
  breakdown: MaterialBreakdownRow[];
  /** Count of lines flagged `unpriced` (additive; does not affect the numbers). */
  unpricedCount: number;
}

const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

function markupTableOf(settings: MaterialCalcSettings): Record<string, number> {
  return settings.materialMarkupPct || { default: 25 };
}

/** Resolve a line's UNROUNDED cost, mirroring the legacy falsy-OR expression
 *  exactly (totalCost===0/NaN falls through to unitCost*qty). */
function resolveLineCost(m: QuoteMaterialItem): number {
  const qty = Number(m.quantity) || 0;
  return (
    (m.totalCost != null && Number(m.totalCost)) ||
    (m.unitCost != null ? Number(m.unitCost) * qty : 0)
  );
}

/** Additive #195 honesty: a line with no usable price source. A truthy+finite
 *  totalCost OR a present unitCost makes it priced (a unitCost with qty 0 is
 *  still "priced", just zero — not flagged). */
function isUnpriced(m: QuoteMaterialItem): boolean {
  const totalUsable = m.totalCost != null && Number.isFinite(Number(m.totalCost)) && Number(m.totalCost) !== 0;
  const unitUsable = m.unitCost != null && Number.isFinite(Number(m.unitCost));
  return !totalUsable && !unitUsable;
}

interface RawMaterialContribution {
  category: string;
  markupPct: number;
  lineCost: number;
  lineSell: number;
  finite: boolean;
  unpriced: boolean;
}

function rawContribution(m: QuoteMaterialItem, settings: MaterialCalcSettings): RawMaterialContribution {
  const markupTbl = markupTableOf(settings);
  const defaultMarkup = Number(markupTbl.default) || 0;
  const lineCost = resolveLineCost(m);
  const category = String(m.category || "Other");
  const markupPct = markupTbl[category] != null ? Number(markupTbl[category]) : defaultMarkup;
  const lineSell = lineCost * (1 + markupPct / 100);
  return {
    category,
    markupPct,
    lineCost,
    lineSell,
    finite: Number.isFinite(lineCost),
    unpriced: isUnpriced(m),
  };
}

/**
 * Compute one material line for DISPLAY (rounded). For accurate section totals
 * use `computeMaterialTotals`, which sums the unrounded contributions and rounds
 * once (legacy parity). Never sum the rounded values returned here.
 */
export function computeMaterialLine(
  m: QuoteMaterialItem,
  settings: MaterialCalcSettings = MATERIAL_CALC_DEFAULTS,
): MaterialLineResult {
  const c = rawContribution(m, settings);
  return {
    category: c.category,
    cost: round2(c.lineCost),
    sell: round2(c.lineSell),
    markupPct: c.markupPct,
    unpriced: c.unpriced,
    skipped: !c.finite,
  };
}

/**
 * Materials section totals over many lines — the legacy `materials` block
 * (`{ cost, sell, breakdown }`) plus an additive `unpricedCount`. Sums UNROUNDED
 * contributions, rounds ONCE at output; the per-category breakdown is in
 * first-seen order with the first-seen markupPct stamped — byte-identical to
 * legacy `computeQuoteTotals(...).materials`.
 */
export function computeMaterialTotals(
  items: ReadonlyArray<QuoteMaterialItem>,
  settings: MaterialCalcSettings = MATERIAL_CALC_DEFAULTS,
): MaterialTotals {
  let matCost = 0;
  let matSell = 0;
  let unpricedCount = 0;
  // Plain object keyed by category — mirrors the oracle's `matBreakdown = {}`
  // so Object.keys() preserves first-seen insertion order exactly.
  const breakdown: Record<string, { cost: number; sell: number; count: number; markupPct: number }> = {};

  for (const m of items) {
    const c = rawContribution(m, settings);
    if (!c.finite) continue; // legacy: `if (!isFinite(lineCost)) continue;`
    matCost += c.lineCost;
    matSell += c.lineSell;
    let row = breakdown[c.category];
    if (!row) {
      // First-seen markupPct is stamped and never overwritten (legacy).
      row = { cost: 0, sell: 0, count: 0, markupPct: c.markupPct };
      breakdown[c.category] = row;
    }
    row.cost += c.lineCost;
    row.sell += c.lineSell;
    row.count += 1;
    if (c.unpriced) unpricedCount += 1;
  }

  return {
    cost: round2(matCost),
    sell: round2(matSell),
    breakdown: Object.keys(breakdown).map((k) => ({
      category: k,
      cost: round2(breakdown[k]!.cost),
      sell: round2(breakdown[k]!.sell),
      markupPct: breakdown[k]!.markupPct,
      count: breakdown[k]!.count,
    })),
    unpricedCount,
  };
}
