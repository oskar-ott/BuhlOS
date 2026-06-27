import { z } from "zod";
import { httpGet, httpPost, type HttpResult } from "@/lib/http";
import {
  PrestartManualItemSchema,
  PrestartOverrideSchema,
  type ReadinessSignals,
} from "./readiness";

/**
 * Client + response contract for /api/job-readiness (#371).
 *
 * The API resolves the REAL signals; the job hub runs the pure
 * `computeReadiness()` engine over them (the engine is TS and can't be required
 * from api/*.js). Mutations persist `jobs/<id>/prestart.json` and return the
 * fresh signals so the panel re-renders from one source of truth.
 */

const CrewRegisterSignalSchema = z.object({ byWorkerId: z.record(z.boolean()) });

export const ReadinessSignalsResponseSchema = z.object({
  crew: z.array(z.object({ id: z.string(), name: z.string() })),
  inductions: CrewRegisterSignalSchema.nullable(),
  licences: CrewRegisterSignalSchema.nullable(),
  safetyDocs: CrewRegisterSignalSchema.nullable(),
  manualItems: z.array(PrestartManualItemSchema),
  override: PrestartOverrideSchema.nullable(),
  /** Presentational only (engine doesn't consume it) — for copy. */
  inductionRequired: z.boolean(),
});

export type ReadinessSignalsResponse = z.infer<typeof ReadinessSignalsResponseSchema>;

/** Drop the presentational flag → the exact signals `computeReadiness` consumes. */
export function signalsFrom(res: ReadinessSignalsResponse): ReadinessSignals {
  return {
    crew: res.crew,
    inductions: res.inductions,
    licences: res.licences,
    safetyDocs: res.safetyDocs,
    manualItems: res.manualItems,
    override: res.override,
  };
}

export function jobReadiness(jobId: string): Promise<HttpResult<ReadinessSignalsResponse>> {
  return httpGet(`/api/job-readiness?jobId=${encodeURIComponent(jobId)}`, {
    schema: ReadinessSignalsResponseSchema,
  });
}

export function tickPrestartItem(
  jobId: string,
  itemId: string,
  ticked: boolean
): Promise<HttpResult<ReadinessSignalsResponse>> {
  return httpPost(
    `/api/job-readiness?jobId=${encodeURIComponent(jobId)}`,
    { action: "tick", itemId, ticked },
    { schema: ReadinessSignalsResponseSchema }
  );
}

export function setReadinessOverride(
  jobId: string,
  reason: string
): Promise<HttpResult<ReadinessSignalsResponse>> {
  return httpPost(
    `/api/job-readiness?jobId=${encodeURIComponent(jobId)}`,
    { action: "override", reason },
    { schema: ReadinessSignalsResponseSchema }
  );
}

export function clearReadinessOverride(
  jobId: string
): Promise<HttpResult<ReadinessSignalsResponse>> {
  return httpPost(
    `/api/job-readiness?jobId=${encodeURIComponent(jobId)}`,
    { action: "clear-override" },
    { schema: ReadinessSignalsResponseSchema }
  );
}
