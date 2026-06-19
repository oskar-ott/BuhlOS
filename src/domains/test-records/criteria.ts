/**
 * The ONE numeric pass/fail derivation rule (#517).
 *
 * A measured value passes when it falls within its min/max criteria. This is the
 * single source of truth for "does this number meet its limits" across the
 * product — structured electrical test records (this domain) AND ITP value-points
 * (`src/domains/itp/format.ts#valuePassFail` delegates here). No second engine.
 *
 * Returns `null` when there is nothing to judge: no criterion (both bounds
 * absent), or the value is not a finite number. Callers map `null` to "n/a".
 */
export type PassFail = "pass" | "fail" | null;

export function evaluateAgainstCriteria(
  value: unknown,
  min: number | null | undefined,
  max: number | null | undefined,
): PassFail {
  // No criterion to compare against → nothing to judge.
  if ((min == null) && (max == null)) return null;
  // No value to judge → n/a, never a coerced 0 (Number(null)/Number("") === 0
  // would otherwise read as a real measurement and could "fail").
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  if (min != null && n < min) return "fail";
  if (max != null && n > max) return "fail";
  return "pass";
}
