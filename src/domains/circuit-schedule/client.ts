import { httpGet, httpPut, type HttpResult } from "@/lib/http";
import { CircuitScheduleResponseSchema } from "./schema";
import type { CircuitSchedulePayload, CircuitScheduleResponse } from "./types";

/**
 * Typed wrapper around /api/job-circuits (legacy endpoint).
 *
 *   GET /api/job-circuits?jobId=<id>  → { switchboards, circuits }
 *   PUT /api/job-circuits?jobId=<id>  → replaces the arrays wholesale, returns
 *                                       the normalised { switchboards, circuits }
 *
 * Read access is anyone who can see the job; the PUT is server-gated to
 * canManageJob (admin / LH-on-job), so a tradie save round-trips a 403 which
 * the builder surfaces as a read-only notice. The schema parse is the same
 * lenient one the page loaders use, so an unknown server enum value never
 * blanks the schedule.
 */

export function fetchCircuitSchedule(
  jobId: string
): Promise<HttpResult<CircuitScheduleResponse>> {
  return httpGet<CircuitScheduleResponse>(
    `/api/job-circuits?jobId=${encodeURIComponent(jobId)}`,
    {
      schema: CircuitScheduleResponseSchema,
      init: { cache: "no-store", credentials: "same-origin" },
    }
  );
}

export function saveCircuitSchedule(
  jobId: string,
  payload: CircuitSchedulePayload
): Promise<HttpResult<CircuitScheduleResponse>> {
  return httpPut<CircuitScheduleResponse>(
    `/api/job-circuits?jobId=${encodeURIComponent(jobId)}`,
    payload,
    {
      schema: CircuitScheduleResponseSchema,
      init: { cache: "no-store", credentials: "same-origin" },
      // Field write on possibly-bad signal — fail honestly rather than hang.
      timeoutMs: 20000,
    }
  );
}
