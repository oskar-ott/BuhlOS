import { z } from "zod";

/**
 * Confidential worker cost-rate types (#304). Money is INTEGER CENTS — display
 * layers divide by 100. The store + endpoint live at api/_lib/cost-rates.js and
 * api/cost-rates.js (admin-tier only).
 */

export const CostRateEntrySchema = z.object({
  id: z.string(),
  costRateCents: z.number().int(),
  chargeOutRateCents: z.number().int().nullable(),
  effectiveFrom: z.string(), // YYYY-MM-DD
  setBy: z.string(),
  setByName: z.string(),
  setAt: z.string(),
});
export type CostRateEntry = z.infer<typeof CostRateEntrySchema>;

export const CostRateHistoryResponseSchema = z.object({
  userId: z.string(),
  history: z.array(CostRateEntrySchema),
  current: CostRateEntrySchema.nullable(),
});
export type CostRateHistoryResponse = z.infer<typeof CostRateHistoryResponseSchema>;

export const CostRateCoverageResponseSchema = z.object({
  tracked: z.number().int(),
  rated: z.number().int(),
  unrated: z.array(
    z.object({ id: z.string(), username: z.string(), role: z.string() }),
  ),
});
export type CostRateCoverageResponse = z.infer<typeof CostRateCoverageResponseSchema>;

/** Cents → "$52.50" (no /h suffix). Pure; null/undefined → "—". */
export function formatCents(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Parse a dollars string ("52.50", "52") into integer cents, or null if it
 * isn't a positive money value. Pure — used by the admin form before POST.
 */
export function dollarsToCents(input: string): number | null {
  const trimmed = String(input ?? "").trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const cents = Math.round(Number(trimmed) * 100);
  return cents > 0 ? cents : null;
}
