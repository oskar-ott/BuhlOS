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
  // Plain object keyed by category — mirrors the ORACLE's data structure exactly
  // (api/quotes.js builds a {} and emits Object.keys(matBreakdown).map(...)). This
  // is parity-critical: JS objects iterate integer-like string keys in ASCENDING
  // NUMERIC order, so categories like "10","2","1" must emit ["1","2","10"] to stay
  // byte-identical to the oracle. A Map (insertion order) would diverge.
  const breakdown: Record<
    string,
    { category: string; cost: number; sell: number; markupPct: number; count: number }
  > = {};
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
    if (!breakdown[cat]) {
      // First-seen markupPct is stamped and never overwritten (legacy).
      breakdown[cat] = { category: cat, cost: 0, sell: 0, markupPct: markup, count: 0 };
    }
    breakdown[cat].cost += lineCost;
    breakdown[cat].sell += lineSell;
    breakdown[cat].count += 1;
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
    // Object.values uses the same [[OwnPropertyKeys]] order as Object.keys —
    // integer-like keys ascending — matching the oracle's Object.keys(...).map(...).
    matBreakdown: Object.values(breakdown),
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

// ════════════════════════════════════════════════════════════════════════════
// #214 commit 2 — per-section attribution + flags + override effective margin +
// the #186 internal-only boundary. ADDITIVE: nothing below changes a legacy
// number. `computeQuoteMargin` (the legacy port) is untouched; this layer reads
// the SAME unrounded accumulators (`rawCompute`) so a section total can never
// disagree with the rollup it sums into.
// ════════════════════════════════════════════════════════════════════════════

/** Health flag for a section / the rollup. `negative` (loss) is ALWAYS distinct
 *  from `low` — a section selling below cost is never "low but positive". */
export type MarginFlag = "ok" | "low" | "negative";

/** Default low-margin threshold (%). The future org-level home is policy.json
 *  (#214 notes); this module only CONSUMES the value via
 *  `options.lowMarginThresholdPct`, never hardcoding it inside the math. */
export const DEFAULT_LOW_MARGIN_THRESHOLD_PCT = 15;

/** A section's stable identity. `quote` is the rollup row. */
export type MarginSectionId = "materials" | "labour" | "provisional" | "quote";

/** One row in the per-section attribution. `marginPct` is `null` (sentinel the
 *  UI renders as "—") when sell is 0 — NEVER NaN or a misleading −100%. */
export interface MarginSectionRow {
  section: MarginSectionId;
  /** Display label for the row (section name, or a category for sub-rows). */
  label: string;
  /** Category sub-rows of the Materials section (one per markup band). The
   *  parent Materials row carries the section cost/sell; sub-rows break it down
   *  and themselves sum to the parent. Empty for non-material sections. */
  subRows: MarginSectionRow[];
  cost: number;
  sell: number;
  margin: {
    amount: number;
    /** `null` when sell == 0 (zero-sell honesty). Otherwise round1 percent. */
    pct: number | null;
  };
  flag: MarginFlag;
}

/** Full per-section attribution + the override-aware rollup. */
export interface QuoteMarginSections {
  /** Materials, Labour, Provisional, then the `quote` rollup — in that order. */
  sections: MarginSectionRow[];
  /** Convenience alias for the rollup row (sections[last]). */
  rollup: MarginSectionRow;
  /**
   * Present ONLY when the quote total is overridden. The margin RECOMPUTED so
   * the cost stays real but the sell becomes the override subtotal ex GST — i.e.
   * "what margin did we actually strike at the negotiated price?". Formula:
   *   effectiveSell  = overrideSubtotalExGst − provisional − contingency
   *                    (strip the non-margin components so the override is
   *                     compared like-for-like against materials+labour cost)
   *   effectiveAmount = effectiveSell − totalCost
   *   effectivePct    = effectiveSell > 0 ? amount/effectiveSell*100 : null
   * The COMPUTED margin (margin{} on the rollup) and this effective-under-
   * override margin are BOTH present, per the issue.
   */
  effectiveMargin: {
    sell: number;
    amount: number;
    pct: number | null;
    flag: MarginFlag;
  } | null;
}

/** Options for the attribution layer. */
export interface QuoteMarginOptions {
  /** Below this %, a positive-margin section/rollup flags `low`. Default
   *  DEFAULT_LOW_MARGIN_THRESHOLD_PCT. A loss always flags `negative` first. */
  lowMarginThresholdPct?: number;
}

/**
 * THE #186 BOUNDARY — single source of truth.
 *
 * These field names carry COST or MARGIN information and MUST NEVER reach a
 * client-/Phil-facing quote view (the client sees sell prices only, never the
 * markup behind them). The future client-split projection (#186) imports THIS
 * set and asserts none of its output keys intersect it. Until that projection
 * exists, the contract is: this set is the non-empty, documented register of
 * internal-only keys, and any new cost/margin field added to this module's
 * output is added HERE in the same change.
 *
 * Frozen so a consumer cannot mutate the contract at runtime.
 */
export const QUOTE_MARGIN_INTERNAL_ONLY_KEYS = Object.freeze([
  "cost",
  "totalCost",
  "margin", // covers nested margin.amount / margin.pct wholesale
  "effectiveMargin",
  "flag",
  "markupPct",
] as const);

export type QuoteMarginInternalOnlyKey = (typeof QUOTE_MARGIN_INTERNAL_ONLY_KEYS)[number];

/**
 * Classify a section's health from its UNROUNDED amount + pct.
 *   - amount < 0            → 'negative' (loss; distinct from low, checked FIRST)
 *   - sell == 0 (pct null)  → 'negative' if cost > 0 (a real loss), else 'ok'
 *   - 0 ≤ pct < threshold   → 'low'
 *   - otherwise             → 'ok'
 */
function classifyFlag(amount: number, pct: number | null, threshold: number): MarginFlag {
  if (amount < 0) return "negative";
  // pct === null means sell == 0. With amount >= 0 here, cost is also 0 (no sell,
  // no cost) → nothing at risk → 'ok'. A >0-cost/0-sell section already has
  // amount = -cost < 0 and was caught above as 'negative'.
  if (pct === null) return "ok";
  if (pct < threshold) return "low";
  return "ok";
}

/** Build a section row from UNROUNDED cost/sell. Applies zero-sell honesty
 *  (sell 0 → pct null, amount = sell − cost so a loss stays visible) and rounds
 *  the displayed figures once. */
function makeSectionRow(
  section: MarginSectionId,
  label: string,
  rawCost: number,
  rawSell: number,
  threshold: number,
  subRows: MarginSectionRow[] = [],
): MarginSectionRow {
  const rawAmount = rawSell - rawCost;
  // Zero-sell honesty: a 0-sell section is NOT "0% healthy". pct is null (UI: —),
  // amount stays sell − cost (= −cost when there's cost) so the loss is visible.
  // Classify on the UNROUNDED pct so a true sub-threshold margin (e.g. 14.95%) is
  // not lifted over the line by round1 — display rounds, classification must not.
  const rawPct = rawSell > 0 ? (rawAmount / rawSell) * 100 : null;
  const pct = rawPct === null ? null : round1(rawPct);
  const flag = classifyFlag(rawAmount, rawPct, threshold);
  return {
    section,
    label,
    subRows,
    cost: round2(rawCost),
    sell: round2(rawSell),
    margin: { amount: round2(rawAmount), pct },
    flag,
  };
}

/**
 * Per-section margin attribution + flags + override effective margin.
 *
 * RECONCILIATION (asserted in tests): the MARGIN-SCOPE section costs/sells
 * (Materials + Labour) reconcile to the rollup `totalCost`/`totalSell` within a
 * single rounding cent. The rollup is round2 of the summed UNROUNDED accumulators
 * (the oracle-EXACT figure); each displayed section is round2'd independently, so
 * Σ(round2 section) can differ from round2(Σ unrounded) by ≤ 1¢ — an inherent
 * round-then-sum vs sum-then-round artifact (see the module header). The rollup,
 * not the sum of the parts, is the authoritative number. Provisional is
 * represented honestly (sell == cost == psTotal, margin 0) but is EXCLUDED from
 * this reconciliation because legacy excludes it from the margin numerator.
 *
 * The Materials category sub-rows reconcile to the Materials parent likewise
 * (within a rounding cent), for the same reason.
 */
export function computeQuoteMarginSections(
  input: QuoteMarginInput,
  options: QuoteMarginOptions = {},
): QuoteMarginSections {
  const r = rawCompute(input);
  const threshold = options.lowMarginThresholdPct ?? DEFAULT_LOW_MARGIN_THRESHOLD_PCT;

  // Materials sub-rows (per markup band) — UNROUNDED accumulators from rawCompute.
  const materialSubRows = r.matBreakdown.map((b) =>
    makeSectionRow("materials", b.category, b.cost, b.sell, threshold),
  );
  const materials = makeSectionRow("materials", "Materials", r.matCost, r.matSell, threshold, materialSubRows);

  const labour = makeSectionRow("labour", "Labour", r.labCost, r.labSell, threshold);

  // Provisional billed at face value — sell == cost == psTotal, margin exactly 0.
  // It is in the quote total but NOT in the margin numerator (legacy), so it is
  // intentionally absent from the sum-to-rollup invariant. Its margin is 0 BY
  // CONSTRUCTION (sold at cost), which is NOT a low-margin warning — it's the
  // intended state — so the flag is FORCED to 'ok'. Letting classifyFlag run
  // would mark every quote-with-a-provisional-sum 'low' (0% < threshold), a
  // false alarm. pct is 0 when psTotal > 0 (genuine sell == cost), null when 0.
  const provisional: MarginSectionRow = {
    ...makeSectionRow("provisional", "Provisional sums", r.psTotal, r.psTotal, threshold),
    flag: "ok",
  };

  // Rollup = materials + labour (the legacy margin scope). Built from the SAME
  // unrounded accumulators so round2(Σ unrounded) === legacy totalCost/totalSell.
  const rollup = makeSectionRow("quote", "Quote total", r.totalCost, r.totalSell, threshold);

  // ── Override effective margin ──
  let effectiveMargin: QuoteMarginSections["effectiveMargin"] = null;
  if (r.overridden) {
    // Strip the non-margin components (provisional + contingency) from the
    // override so it compares like-for-like against materials+labour COST. The
    // contingency stripped is the share that WOULD have applied at the computed
    // subtotal; we use the computed contingency amount (its dollar value doesn't
    // change with the override — it's a derived line, not re-solved). psTotal is
    // billed at face value either way, so it is removed too.
    const effectiveSell = r.subtotalExGst - r.psTotal - r.contingency;
    const effectiveAmount = effectiveSell - r.totalCost;
    // Classify on the UNROUNDED pct (same rule as makeSectionRow) so the threshold
    // comparison is not skewed by display rounding.
    const effectiveRawPct = effectiveSell > 0 ? (effectiveAmount / effectiveSell) * 100 : null;
    const effectivePct = effectiveRawPct === null ? null : round1(effectiveRawPct);
    effectiveMargin = {
      sell: round2(effectiveSell),
      amount: round2(effectiveAmount),
      pct: effectivePct,
      flag: classifyFlag(effectiveAmount, effectiveRawPct, threshold),
    };
  }

  return {
    sections: [materials, labour, provisional, rollup],
    rollup,
    effectiveMargin,
  };
}
