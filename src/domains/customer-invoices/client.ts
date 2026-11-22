import { httpGet, httpPost, httpPut, type HttpResult } from "@/lib/http";
import {
  JobInvoicingResponseSchema,
  type JobInvoicingResponse,
  type StageInput,
} from "./schema";

/**
 * Client for /api/customer-invoices (customer stage invoices, #1148).
 * Admin-tier only on the server and dark behind `customer_invoices`: a 403 or
 * 404 surfaces as an HttpResult error so the card can hide itself rather than
 * show a money surface. Every mutation answers with the job's whole refreshed
 * payload, so the screen never has to guess what changed.
 */

const BASE = "/api/customer-invoices";
const opts = { schema: JobInvoicingResponseSchema };

export function jobInvoicing(jobId: string): Promise<HttpResult<JobInvoicingResponse>> {
  return httpGet(`${BASE}?jobId=${encodeURIComponent(jobId)}`, opts);
}

export function addStage(
  jobId: string,
  stage: StageInput
): Promise<HttpResult<JobInvoicingResponse>> {
  return httpPost(`${BASE}?action=stage-add`, { jobId, stage }, opts);
}

export function editStage(
  stageId: string,
  stage: StageInput,
  expectedVersion: number
): Promise<HttpResult<JobInvoicingResponse>> {
  return httpPost(
    `${BASE}?action=stage-edit&id=${encodeURIComponent(stageId)}`,
    { stage, expectedVersion },
    opts
  );
}

export function removeStage(
  stageId: string,
  expectedVersion: number
): Promise<HttpResult<JobInvoicingResponse>> {
  return httpPost(
    `${BASE}?action=stage-remove&id=${encodeURIComponent(stageId)}`,
    { expectedVersion },
    opts
  );
}

export function saveRetention(
  jobId: string,
  retentionBp: number,
  expectedVersion: number | null
): Promise<HttpResult<JobInvoicingResponse>> {
  return httpPut(`${BASE}?action=profile`, { jobId, retentionBp, expectedVersion }, opts);
}

/** The Money card announces a contract-value save on `window` so this card's
 *  % stages and "still to invoice" follow without a reload. */
export const JOB_CONTRACT_CHANGED_EVENT = "buhlos:job-contract-changed";

export function announceJobContractChanged(jobId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(JOB_CONTRACT_CHANGED_EVENT, { detail: { jobId } }));
}

/** Stable error code from a failed call's body ({ error: "<code>" }). */
export function errorCodeOf(body: unknown): string | null {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error?: unknown }).error;
    return typeof e === "string" ? e : null;
  }
  return null;
}
