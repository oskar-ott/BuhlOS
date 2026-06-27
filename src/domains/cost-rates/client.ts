import { httpGet, httpPost, type HttpResult } from "@/lib/http";
import {
  CostRateCoverageResponseSchema,
  CostRateHistoryResponseSchema,
  type CostRateCoverageResponse,
  type CostRateHistoryResponse,
} from "./schema";

/**
 * Client verbs for /api/cost-rates (#304). ADMIN-TIER ONLY on the server — a
 * non-admin response is surfaced as an HttpResult error, never silently empty.
 */

export async function costRatesFor(
  userId: string,
): Promise<HttpResult<CostRateHistoryResponse>> {
  return httpGet(`/api/cost-rates?userId=${encodeURIComponent(userId)}`, {
    schema: CostRateHistoryResponseSchema,
  });
}

export async function setCostRate(payload: {
  userId: string;
  costRateCents: number;
  chargeOutRateCents?: number | null;
  effectiveFrom: string;
}): Promise<HttpResult<CostRateHistoryResponse>> {
  return httpPost("/api/cost-rates", payload, {
    schema: CostRateHistoryResponseSchema,
    timeoutMs: 15000,
  });
}

export async function costRateCoverage(): Promise<HttpResult<CostRateCoverageResponse>> {
  return httpGet("/api/cost-rates?action=coverage", {
    schema: CostRateCoverageResponseSchema,
  });
}
