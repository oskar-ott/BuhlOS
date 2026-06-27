import { z } from "zod";
import { httpGet, type HttpResult } from "@/lib/http";

/**
 * Client for GET /api/job-profitability (#327). Admin-tier only on the server;
 * a non-admin response surfaces as an HttpResult error, never silently empty.
 * Money is integer cents — display divides by 100.
 */

/** One budget line (#341): actual vs budget → variance $ and %. */
export const BudgetLineSchema = z.object({
  actualCents: z.number(),
  budgetCents: z.number().nullable(),
  varianceCents: z.number().nullable(),
  variancePct: z.number().nullable(),
});
export type BudgetLine = z.infer<typeof BudgetLineSchema>;

export const JobProfitabilityResponseSchema = z.object({
  jobId: z.string(),
  contractValueCents: z.number().nullable(),
  labourCostCents: z.number(),
  materialCostCents: z.number(),
  marginCents: z.number().nullable(),
  marginPct: z.number().nullable(),
  completeness: z.object({
    labour: z.enum(["complete", "understated"]),
    material: z.enum(["consumption", "received_proxy", "none"]),
    unratedWorkers: z.array(z.string()),
  }),
  badges: z.array(z.string()),
  // #341: budget variance — actual vs estimate, the same money module as margin.
  budget: z.object({
    labourEstimateCents: z.number().nullable(),
    materialEstimateCents: z.number().nullable(),
  }),
  variance: z.object({ labour: BudgetLineSchema, material: BudgetLineSchema, total: BudgetLineSchema }),
  hoursTotal: z.number(),
  asOf: z.string(),
});
export type JobProfitabilityResponse = z.infer<typeof JobProfitabilityResponseSchema>;

export async function jobProfitability(
  jobId: string,
): Promise<HttpResult<JobProfitabilityResponse>> {
  return httpGet(`/api/job-profitability?jobId=${encodeURIComponent(jobId)}`, {
    schema: JobProfitabilityResponseSchema,
  });
}

/** Cents → "$1,234" (whole dollars, thousands-separated) or "$1,234.50" when
 *  there are cents. Null → "—". Pure. */
export function formatMoneyCents(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  const body = rem === 0
    ? dollars.toLocaleString("en-AU")
    : `${dollars.toLocaleString("en-AU")}.${String(rem).padStart(2, "0")}`;
  return `${neg ? "-$" : "$"}${body}`;
}
