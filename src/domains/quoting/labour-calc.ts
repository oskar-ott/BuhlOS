/**
 * Labour calculator — pure, dependency-free (#193).
 *
 * THE PARITY ORACLE. The rich labour math (cost modes, crewSize, riskFactor,
 * uniform sell rate, margin) lives in legacy `api/quotes.js` `computeQuoteTotals`
 * (the labour loop, ~lines 820-833). The quoting v2 foundation
 * (src/domains/quoting/totals.ts) DELIBERATELY excludes that machinery (see its
 * boundary comment §8). This module is where it grows — ported VERBATIM from the
 * legacy loop so the numbers are byte-identical. labour-calc.test.ts runs the
 * same fixtures through the live legacy `computeQuoteTotals` and asserts equality.
 *
 * LEGACY FORMULA (per labour line `l`, pricing `p`):
 *   hours    = (Number(l.estimatedHours) || 0) * (Number(l.crewSize) || 1)
 *   risk     = Number(l.riskFactor) || 1.0
 *   adjHours = hours * risk
 *   costRate = (p.labourCostMode === 'shared') ? Number(p.labourCostRate)
 *                : (l.hourlyRate != null ? Number(l.hourlyRate) : Number(p.labourCostRate))
 *   if isFinite(costRate): cost += adjHours * costRate
 *   sellRate = Number(p.labourSellRate)
 *   if isFinite(sellRate): sell += adjHours * sellRate
 * Section: hours=round2(Σ adjHours), cost=round2(Σcost), sell=round2(Σsell).
 * Margin: amount=round2(sell-cost), pct=round1(sell>0?(sell-cost)/sell*100:0).
 *
 * PARITY-CRITICAL DETAILS (do not "fix"):
 *   - `crewSize || 1` and `riskFactor || 1.0` ARE coercions: 0 → 1. Kept exactly.
 *   - riskFactor is UNCAPPED.
 *   - Sums are accumulated UNROUNDED and rounded ONCE at the end (round2). Do NOT
 *     round per line then sum — that drifts from legacy on many small lines.
 *   - `unpriced` is ADDITIVE honesty (#195 spirit) and NEVER changes a number:
 *     it flags lines where the effective costRate is not finite/resolvable. With
 *     the standard defaults (labourCostRate present) no line is ever unpriced, so
 *     totals stay identical to legacy. A line only goes unpriced when settings
 *     give no usable costRate AND the line has no hourlyRate — legacy already
 *     contributes 0 cost there (isFinite gate); we add the flag, not a fake $0.
 *
 * SELL-RATE DECISION (parity-preserving): sell is driven by `settings.labourSellRate`
 * for EVERY line — exactly as legacy. The preset layer captures a preset's sellRate
 * for display/future use but the calc still uses settings.labourSellRate. There is
 * NO per-line sell override path (adding one would diverge from legacy). The preset
 * only pre-fills the COST side (`hourlyRate`) plus a snapshot id/name.
 */

export type LabourCostMode = "per-line" | "shared";

/** Pricing settings that drive the labour math. Mirrors the legacy
 *  PRICING_DEFAULTS subset {labourSellRate, labourCostMode, labourCostRate}. */
export interface LabourCalcSettings {
  /** Hourly rate billed to the client (uniform across all lines). Legacy: 95. */
  labourSellRate: number;
  /** 'per-line' uses each line's hourlyRate (falling back to labourCostRate);
   *  'shared' forces labourCostRate for every line. Legacy: 'per-line'. */
  labourCostMode: LabourCostMode;
  /** Fallback/shared cost rate. Legacy: 65. May be null/non-finite, in which
   *  case lines with no hourlyRate become `unpriced`. */
  labourCostRate: number | null;
}

/** Standard defaults — mirror api/quotes.js PRICING_DEFAULTS (labour subset).
 *  With these, every line resolves a cost rate, so `unpriced` is always false
 *  and totals are byte-identical to legacy. */
export const LABOUR_CALC_DEFAULTS: LabourCalcSettings = {
  labourSellRate: 95,
  labourCostMode: "per-line",
  labourCostRate: 65,
};

/** A labour line, in the legacy shape (only the fields the math reads, plus the
 *  optional preset snapshot stamps). Extra fields are ignored. */
export interface LabourCalcLine {
  estimatedHours?: number | null;
  /** Coerced `|| 1` (0 → 1), exactly as legacy. */
  crewSize?: number | null;
  /** Per-line cost rate (per-line mode). null → falls back to labourCostRate. */
  hourlyRate?: number | null;
  /** Coerced `|| 1.0` (0 → 1.0), uncapped, exactly as legacy. */
  riskFactor?: number | null;
  /** Snapshot stamp from applyPresetToLine — does NOT affect the math. */
  ratePresetId?: string | null;
  ratePresetName?: string | null;
}

/** Per-line computed result. `hours` is the rounded (display) adjusted hours;
 *  `cost`/`sell` are rounded per-line for display only. Section totals re-sum
 *  the UNROUNDED contributions internally (legacy parity), so never sum these. */
export interface LabourLineResult {
  /** Adjusted hours = estimatedHours·crewSize·riskFactor (round2 for display). */
  hours: number;
  /** Resolved cost rate (NaN when unresolvable — see `unpriced`). */
  costRate: number;
  /** Resolved sell rate (= settings.labourSellRate when finite, else NaN). */
  sellRate: number;
  /** adjHours · costRate (round2). 0 when unpriced. */
  cost: number;
  /** adjHours · sellRate (round2). */
  sell: number;
  /** True when the effective cost rate is not finite/resolvable. Additive
   *  honesty: the line contributes 0 cost but is flagged, never silent-$0. */
  unpriced: boolean;
}

/** Section totals — legacy `{hours,cost,sell,sellRate}` PLUS a margin block. */
export interface LabourTotals {
  hours: number;
  cost: number;
  sell: number;
  /** The uniform client sell rate (legacy `labour.sellRate`). */
  sellRate: number;
  margin: { amount: number; pct: number };
  /** Count of lines flagged `unpriced` (0 with standard defaults). Additive. */
  unpricedCount: number;
}

/** A reusable rate preset (cost + sell). Snapshot-on-use: rates are COPIED onto
 *  a line at apply time, so later editing the preset does not change applied lines. */
export interface RatePreset {
  id: string;
  name: string;
  /** The loaded (all-in) cost rate this preset stamps onto a line's hourlyRate. */
  loadedCostRate: number;
  /** The preset's sell rate — CAPTURED for display/future; the calc still uses
   *  settings.labourSellRate (parity). Not applied as a per-line override. */
  sellRate: number;
  archived: boolean;
}

const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;
const round1 = (n: number): number => Math.round((Number(n) || 0) * 10) / 10;

/** The raw rate source a line resolves to, BEFORE Number() coercion. In shared
 *  mode that's always labourCostRate; in per-line mode it's the line's hourlyRate
 *  when present, else labourCostRate. Mirrors the legacy ternary's source. */
function rawCostRateSource(line: LabourCalcLine, settings: LabourCalcSettings): unknown {
  if (settings.labourCostMode === "shared") return settings.labourCostRate;
  return line.hourlyRate != null ? line.hourlyRate : settings.labourCostRate;
}

/** Resolve the effective cost rate for a line (UNROUNDED). Mirrors the legacy
 *  ternary + Number() coercion exactly, so the NUMBERS match legacy. */
function resolveCostRate(line: LabourCalcLine, settings: LabourCalcSettings): number {
  return Number(rawCostRateSource(line, settings));
}

/**
 * Is the line genuinely unpriced? "No usable rate" = the resolved source is
 * null/undefined (genuinely absent) OR coerces to a non-finite number. This is
 * the #195 honesty distinction: legacy's `Number(null) === 0` silently books $0
 * "cost" with no rate behind it — we flag that, but never change the number
 * (legacy already contributes 0 cost via the isFinite gate / the 0 multiply).
 */
function isUnpriced(line: LabourCalcLine, settings: LabourCalcSettings): boolean {
  const src = rawCostRateSource(line, settings);
  if (src == null) return true; // null/undefined → genuinely no rate
  return !Number.isFinite(Number(src)); // e.g. "" → NaN, or an unparseable value
}

/** Unrounded per-line contributions — the summation primitive (legacy parity:
 *  sum unrounded, round once). Internal. */
interface RawLineContribution {
  adjHours: number;
  costRate: number;
  sellRate: number;
  rawCost: number;
  rawSell: number;
  unpriced: boolean;
}

function rawContribution(line: LabourCalcLine, settings: LabourCalcSettings): RawLineContribution {
  const hours = (Number(line.estimatedHours) || 0) * (Number(line.crewSize) || 1);
  const risk = Number(line.riskFactor) || 1.0;
  const adjHours = hours * risk;

  const costRate = resolveCostRate(line, settings);
  // NUMERIC parity: legacy gates the cost contribution on isFinite(costRate)
  // (Number(null)===0 is finite → contributes 0). We mirror that EXACTLY so the
  // numbers never diverge.
  const costFinite = Number.isFinite(costRate);
  const rawCost = costFinite ? adjHours * costRate : 0;

  const sellRate = Number(settings.labourSellRate);
  const sellFinite = Number.isFinite(sellRate);
  const rawSell = sellFinite ? adjHours * sellRate : 0;

  return {
    adjHours,
    costRate,
    sellRate,
    rawCost,
    rawSell,
    // HONESTY flag is INDEPENDENT of the numeric gate: a line whose only "rate"
    // is a coerced 0 (null source) is flagged even though legacy books 0 cost.
    unpriced: isUnpriced(line, settings),
  };
}

/**
 * Compute a single line's result for DISPLAY (rounded). For accurate section
 * totals use `computeLabourTotals`, which sums the unrounded contributions and
 * rounds once (legacy parity). Never sum the rounded values returned here.
 */
export function computeLabourLine(
  line: LabourCalcLine,
  settings: LabourCalcSettings = LABOUR_CALC_DEFAULTS,
): LabourLineResult {
  const c = rawContribution(line, settings);
  return {
    hours: round2(c.adjHours),
    costRate: c.costRate,
    sellRate: c.sellRate,
    cost: round2(c.rawCost),
    sell: round2(c.rawSell),
    unpriced: c.unpriced,
  };
}

/**
 * Section totals over many lines — the parity oracle's `labour` block plus a
 * margin block. Sums UNROUNDED contributions, rounds ONCE at the end (exactly
 * as legacy `computeQuoteTotals`). With standard defaults the `{hours,cost,sell,
 * sellRate}` here equals legacy's `.labour` byte-for-byte.
 */
export function computeLabourTotals(
  lines: ReadonlyArray<LabourCalcLine>,
  settings: LabourCalcSettings = LABOUR_CALC_DEFAULTS,
): LabourTotals {
  let hours = 0;
  let cost = 0;
  let sell = 0;
  let unpricedCount = 0;

  for (const line of lines) {
    const c = rawContribution(line, settings);
    hours += c.adjHours;
    cost += c.rawCost;
    sell += c.rawSell;
    if (c.unpriced) unpricedCount += 1;
  }

  const roundedCost = round2(cost);
  const roundedSell = round2(sell);
  const marginAmount = round2(roundedSell - roundedCost);
  const marginPct = round1(roundedSell > 0 ? ((roundedSell - roundedCost) / roundedSell) * 100 : 0);

  // sellRate mirrors legacy `labour.sellRate = Number(p.labourSellRate) || 0`.
  const sellRate = Number(settings.labourSellRate) || 0;

  return {
    hours: round2(hours),
    cost: roundedCost,
    sell: roundedSell,
    sellRate,
    margin: { amount: marginAmount, pct: marginPct },
    unpricedCount,
  };
}

/**
 * Snapshot-on-use: apply a preset to a line. Returns a NEW line that carries the
 * preset's id + name (snapshot) and the RESOLVED cost rate copied onto
 * `hourlyRate`. Because the rate is copied at apply time, later editing the
 * preset object does NOT change an already-applied line's totals (independence,
 * same rule as templates #245).
 *
 * The preset's sellRate is intentionally NOT written onto the line: sell stays
 * driven by settings.labourSellRate to preserve legacy parity (see module header).
 */
export function applyPresetToLine<T extends LabourCalcLine>(line: T, preset: RatePreset): T {
  return {
    ...line,
    hourlyRate: preset.loadedCostRate,
    ratePresetId: preset.id,
    ratePresetName: preset.name,
  };
}
