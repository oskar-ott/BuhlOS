/**
 * Quote margin calculator — pure, dependency-free (#214).
 *
 * THE FULL COMPOSITION. Where totals.ts (#183) deliberately stops at "line
 * totals → GST" (see its §8 boundary comment) and labour-calc.ts (#193) owns
 * just the labour math, THIS module is the whole legacy pricing pipeline:
 * per-category material markup, labour cost/sell (REUSED from labour-calc),
 * provisional sums, contingency, fixed-price override, GST, and the internal
 * cost-vs-sell MARGIN — per section AND for the quote rollup.
 *
 * THE PARITY ORACLE is legacy `api/quotes.js` `computeQuoteTotals` (exported
 * as `module.exports.computeQuoteTotals`). `computeQuoteMargin` is BYTE-
 * IDENTICAL to that function for the same inputs across the shared return
 * fields; margin.test.ts runs the live oracle over golden fixtures and asserts
 * deep equality, so parity is an executable contract, not a hand-derived
 * comment.
 *
 * INPUT SHAPE (the legacy section bundle the oracle takes):
 *   { pricing, materials:{items:[]}, labour:{lines:[]}, provisional:{items:[]} }
 *
 * NAMING: legacy and totals.ts both export `computeQuoteTotals` with DIFFERENT
 * signatures. To avoid any collision this module's entry point is
 * `computeQuoteMargin` (it returns the legacy-totals-equivalent object plus the
 * #214 per-section / flag / override extensions).
 *
 * ── Commit-1 scope (this file's base) ─────────────────────────────────────
 * Faithful full port: `computeQuoteMargin(input)` returns the legacy totals
 * object. The #214 per-section attribution, zero-sell honesty, override
 * effective margin, low/negative flagging and the internal-only key boundary
 * are added ADDITIVELY in commit 2 (same file) — they never change a legacy
 * number.
 *
 * LEGACY FORMULA (reproduced exactly — see api/quotes.js ~793-905):
 *   p = {...PRICING_DEFAULTS, ...pricing}
 *   markupTbl = p.materialMarkupPct || {default:25}; defaultMarkup = Number(markupTbl.default)||0
 *   MATERIALS per item m:
 *     qty = Number(m.quantity)||0
 *     lineCost = (m.totalCost != null && Number(m.totalCost)) || (m.unitCost != null ? Number(m.unitCost)*qty : 0)
 *       ↑ PRESERVE the falsy precedence: a totalCost of 0 is falsy → falls through to unitCost*qty.
 *     if (!isFinite(lineCost)) continue
 *     cat = String(m.category || 'Other')
 *     markup = (markupTbl[cat] != null) ? Number(markupTbl[cat]) : defaultMarkup   // negative allowed
 *     lineSell = lineCost * (1 + markup/100)
 *     accumulate matCost, matSell + per-category {cost,sell,count,markupPct}
 *   LABOUR: computeLabourTotals(labour.lines, {labourSellRate, labourCostMode, labourCostRate})
 *           → .cost (labCost) and .sell (labSell). (crewSize||1, riskFactor||1.0, per-line/shared,
 *           null hourlyRate→labourCostRate, sum-unrounded-then-round — all owned by labour-calc.)
 *   PROVISIONAL: psTotal = Σ (Number(ps.amountExGst)||0 where isFinite)
 *   subBeforeContingency = matSell + labSell + psTotal
 *   contingency = subBeforeContingency * (contingencyPct/100)
 *   subtotalExGst = subBeforeContingency + contingency
 *     if pricing.overrideTotalExGst != null && isFinite → subtotalExGst = Number(override); overridden=true
 *   gst = subtotalExGst * (gstPct/100); totalIncGst = subtotalExGst + gst
 *   MARGIN (materials + labour ONLY — PS and contingency EXCLUDED):
 *     totalCost = matCost + labCost; totalSell = matSell + labSell
 *     marginAmount = totalSell - totalCost
 *     marginPct = totalSell > 0 ? (marginAmount/totalSell)*100 : 0
 *   Round: money fields → round2; marginPct → round1.
 *
 * PARITY-CRITICAL (do not "fix"):
 *   - Accumulate UNROUNDED, round ONCE at output. The margin is differenced
 *     from the UNROUNDED accumulators (round2(totalSell-totalCost)), NEVER from
 *     the rounded section totals — round2(a-b) != round2(round2(a)-round2(b))
 *     on sub-cent quotes (the #193 margin lesson).
 *   - `(m.totalCost != null && Number(m.totalCost)) || …` keeps its falsy
 *     precedence: totalCost === 0 falls through to unitCost*qty.
 *   - Negative category markup is allowed (PATCH permits −50%).
 *   - matBreakdown stamps the FIRST-seen markupPct per category (legacy sets it
 *     on first creation and never overwrites).
 */

import { computeLabourTotals, type LabourCalcLine, type LabourCalcSettings } from "./labour-calc";

// ── Legacy PRICING_DEFAULTS (mirror api/quotes.js ~124-145, the pricing subset
//    computeQuoteTotals actually reads). Kept here so the module is dependency-
//    free; the oracle test pins these against the live legacy defaults. ──────
export const QUOTE_PRICING_DEFAULTS = {
  materialMarkupPct: { default: 25 } as Record<string, number>,
  labourSellRate: 95,
  labourCostMode: "per-line" as "per-line" | "shared",
  labourCostRate: 65 as number | null,
  contingencyPct: 0,
  gstPct: 10,
  overrideTotalExGst: null as number | null,
} as const;

// ── Input types (legacy section-bundle shape) ─────────────────────────────

/** A material line, legacy shape (only fields the math reads). Extra ignored. */
export interface QuoteMaterialItem {
  quantity?: number | null;
  /** Total cost for the line. NOTE: a value of 0 is FALSY and falls through to
   *  unitCost*qty (legacy `(totalCost != null && Number(totalCost)) || …`). */
  totalCost?: number | null;
  unitCost?: number | null;
  /** Category key into materialMarkupPct; missing → 'Other' → default markup. */
  category?: string | null;
}

/** A provisional-sum item — billed at face value, never marked up. */
export interface QuoteProvisionalItem {
  amountExGst?: number | null;
}

/** Pricing settings (legacy PRICING_DEFAULTS subset). All optional — anything
 *  omitted falls back to QUOTE_PRICING_DEFAULTS via the same Object.assign the
 *  oracle uses. */
export interface QuotePricing {
  /** Per-category markup %; `default` is the fallback. Negative allowed. */
  materialMarkupPct?: Record<string, number> | null;
  labourSellRate?: number;
  labourCostMode?: "per-line" | "shared";
  labourCostRate?: number | null;
  contingencyPct?: number;
  gstPct?: number;
  /** When set + finite, REPLACES the computed subtotal ex GST. */
  overrideTotalExGst?: number | null;
}

/** The legacy section bundle `computeQuoteTotals` takes. */
export interface QuoteMarginInput {
  pricing?: QuotePricing | null;
  materials?: { items?: QuoteMaterialItem[] | null } | null;
  labour?: { lines?: LabourCalcLine[] | null } | null;
  provisional?: { items?: QuoteProvisionalItem[] | null } | null;
}

// ── Output types ──────────────────────────────────────────────────────────

/** Per-category material sub-row (legacy materials.breakdown entry). */
export interface MaterialBreakdownRow {
  category: string;
  cost: number;
  sell: number;
  markupPct: number;
  count: number;
}

/** The legacy-equivalent totals object. Field-for-field identical to
 *  `computeQuoteTotals`'s return across these keys. */
export interface QuoteMarginTotals {
  materials: { cost: number; sell: number; breakdown: MaterialBreakdownRow[] };
  labour: { hours: number; cost: number; sell: number; sellRate: number };
  provisional: { total: number; count: number };
  contingency: { pct: number; amount: number };
  subtotalExGst: number;
  gstPct: number;
  gst: number;
  totalIncGst: number;
  totalCost: number;
  totalSell: number;
  margin: { amount: number; pct: number };
  overridden: boolean;
}

const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;
const round1 = (n: number): number => Math.round((Number(n) || 0) * 10) / 10;

/** Internal: the UNROUNDED accumulators, computed once and reused by both the
 *  legacy-port output (commit 1) and the per-section attribution (commit 2) so
 *  the two can never disagree about a number. */
interface RawCompute {
  matCost: number;
  matSell: number;
  /** Per-category, UNROUNDED, in first-seen order (legacy Object.keys order). */
  matBreakdown: Array<{ category: string; cost: number; sell: number; markupPct: number; count: number }>;
  labHours: number;
  labCost: number;
  labSell: number;
  labSellRate: number;
  psTotal: number;
  psCount: number;
  contingencyPct: number;
  contingency: number;
  /** Pre-override subtotal (matSell + labSell + psTotal + contingency). */
  computedSubtotalExGst: number;
  /** The subtotal actually used downstream (override applied if present). */
  subtotalExGst: number;
  overridden: boolean;
  gstPct: number;
  gst: number;
  totalIncGst: number;
  /** Margin-scope totals: materials + labour only (PS + contingency excluded). */
  totalCost: number;
  totalSell: number;
}

/** Resolve effective pricing exactly as legacy `Object.assign({}, DEFAULTS, p)`. */
function resolvePricing(pricing: QuotePricing | null | undefined) {
  return { ...QUOTE_PRICING_DEFAULTS, ...(pricing || {}) };
}

/** The single unrounded pass. Mirrors the legacy loop byte-for-byte; labour is
 *  delegated to labour-calc (parity-proven against the SAME oracle). */
function rawCompute(input: QuoteMarginInput): RawCompute {
  const p = resolvePricing(input.pricing);
  const items = (input.materials && input.materials.items) || [];
  const lines = (input.labour && input.labour.lines) || [];
  const psItems = (input.provisional && input.provisional.items) || [];

  const markupTbl: Record<string, number> = p.materialMarkupPct || { default: 25 };
  const defaultMarkup = Number(markupTbl.default) || 0;

  // ── Materials (UNROUNDED accumulation, per-category breakdown) ──
  let matCost = 0;
  let matSell = 0;
  // Map preserves first-insertion order — mirrors legacy Object.keys ordering.
  const breakdown = new Map<
    string,
    { category: string; cost: number; sell: number; markupPct: number; count: number }
  >();
  for (const m of items) {
    const qty = Number(m.quantity) || 0;
    // PRESERVE legacy falsy precedence: totalCost === 0 is falsy → unitCost*qty.
    const lineCost =
      (m.totalCost != null && Number(m.totalCost)) ||
      (m.unitCost != null ? Number(m.unitCost) * qty : 0);
    if (!isFinite(lineCost)) continue;
    const cat = String(m.category || "Other");
    const markup = markupTbl[cat] != null ? Number(markupTbl[cat]) : defaultMarkup;
    const lineSell = lineCost * (1 + markup / 100);
    matCost += lineCost;
    matSell += lineSell;
    let row = breakdown.get(cat);
    if (!row) {
      // First-seen markupPct is stamped and never overwritten (legacy).
      row = { category: cat, cost: 0, sell: 0, markupPct: markup, count: 0 };
      breakdown.set(cat, row);
    }
    row.cost += lineCost;
    row.sell += lineSell;
    row.count += 1;
  }

  // ── Labour ──
  // The `labour` BLOCK is REUSED from labour-calc verbatim (parity-proven, #193):
  // its round2'd {hours,cost,sell,sellRate} IS legacy's `labour.*` block.
  const labourSettings: LabourCalcSettings = {
    labourSellRate: p.labourSellRate,
    labourCostMode: p.labourCostMode,
    labourCostRate: p.labourCostRate,
  };
  const labour = computeLabourTotals(lines, labourSettings);
  const labHours = labour.hours;
  const labSellRate = labour.sellRate;
  // The labour BLOCK's cost/sell are round2'd. But legacy composes the SUBTOTAL
  // and the MARGIN from the UNROUNDED labour accumulators (labCost/labSell are
  // round2'd only at output, while subBeforeContingency and totalCost/totalSell
  // read the raw sums). Feeding the rounded labour cost/sell into the subtotal
  // drifts a cent vs the oracle on sub-cent quotes (round2(a)+round2(b) !=
  // round2(a+b)). So we sum labour cost/sell UNROUNDED here, mirroring the
  // labour-calc/legacy per-line formula EXACTLY (crewSize||1, riskFactor||1.0,
  // shared|per-line cost rate w/ null hourlyRate→labourCostRate, isFinite gate).
  // labour-calc remains the canonical owner of the labour math + its `unpriced`
  // honesty; this is the unrounded-accumulator the public API does not expose.
  let rawLabCost = 0;
  let rawLabSell = 0;
  const sellRate = Number(p.labourSellRate);
  const sellFinite = Number.isFinite(sellRate);
  for (const l of lines) {
    const hrs = (Number(l.estimatedHours) || 0) * (Number(l.crewSize) || 1);
    const risk = Number(l.riskFactor) || 1.0;
    const adjHours = hrs * risk;
    const costRate =
      p.labourCostMode === "shared"
        ? Number(p.labourCostRate)
        : l.hourlyRate != null
          ? Number(l.hourlyRate)
          : Number(p.labourCostRate);
    if (Number.isFinite(costRate)) rawLabCost += adjHours * costRate;
    if (sellFinite) rawLabSell += adjHours * sellRate;
  }
  const labCost = rawLabCost;
  const labSell = rawLabSell;

  // ── Provisional (face value, never marked up) ──
  let psTotal = 0;
  for (const ps of psItems) {
    const a = Number(ps.amountExGst) || 0;
    if (isFinite(a)) psTotal += a;
  }

  // ── Subtotal + contingency + override ──
  const subBeforeContingency = matSell + labSell + psTotal;
  const contingencyPct = Number(p.contingencyPct) || 0;
  const contingency = subBeforeContingency * (contingencyPct / 100);

  let subtotalExGst = subBeforeContingency + contingency;
  const computedSubtotalExGst = subtotalExGst;
  let overridden = false;
  if (p.overrideTotalExGst != null && isFinite(Number(p.overrideTotalExGst))) {
    subtotalExGst = Number(p.overrideTotalExGst);
    overridden = true;
  }

  const gstPct = Number(p.gstPct) || 0;
  const gst = subtotalExGst * (gstPct / 100);
  const totalIncGst = subtotalExGst + gst;

  // ── Margin scope: materials + labour only ──
  const totalCost = matCost + labCost;
  const totalSell = matSell + labSell;

  return {
    matCost,
    matSell,
    matBreakdown: [...breakdown.values()],
    labHours,
    labCost,
    labSell,
    labSellRate,
    psTotal,
    psCount: psItems.length,
    contingencyPct,
    contingency,
    computedSubtotalExGst,
    subtotalExGst,
    overridden,
    gstPct,
    gst,
    totalIncGst,
    totalCost,
    totalSell,
  };
}

/**
 * Full quote totals — BYTE-IDENTICAL to legacy `computeQuoteTotals` for the
 * same input. Materials (with per-category breakdown), labour (via labour-calc),
 * provisional, contingency, GST, and the internal cost-vs-sell margin.
 *
 * `marginPct` is round1; every money field is round2. The margin is differenced
 * from the UNROUNDED accumulators then rounded once (never round-then-difference).
 */
export function computeQuoteMargin(input: QuoteMarginInput): QuoteMarginTotals {
  const r = rawCompute(input);
  const marginAmount = r.totalSell - r.totalCost;
  const marginPct = r.totalSell > 0 ? (marginAmount / r.totalSell) * 100 : 0;

  return {
    materials: {
      cost: round2(r.matCost),
      sell: round2(r.matSell),
      breakdown: r.matBreakdown.map((b) => ({
        category: b.category,
        cost: round2(b.cost),
        sell: round2(b.sell),
        markupPct: b.markupPct,
        count: b.count,
      })),
    },
    labour: {
      hours: round2(r.labHours),
      cost: round2(r.labCost),
      sell: round2(r.labSell),
      sellRate: r.labSellRate,
    },
    provisional: {
      total: round2(r.psTotal),
      count: r.psCount,
    },
    contingency: {
      pct: r.contingencyPct,
      amount: round2(r.contingency),
    },
    subtotalExGst: round2(r.subtotalExGst),
    gstPct: r.gstPct,
    gst: round2(r.gst),
    totalIncGst: round2(r.totalIncGst),
    totalCost: round2(r.totalCost),
    totalSell: round2(r.totalSell),
    margin: {
      amount: round2(marginAmount),
      pct: round1(marginPct),
    },
    overridden: r.overridden,
  };
}
