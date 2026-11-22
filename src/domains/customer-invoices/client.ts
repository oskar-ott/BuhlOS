import { httpGet, httpPost, httpPut, type HttpResult } from "@/lib/http";
import {
  ContactSearchResponseSchema,
  InvoiceSettingsOptionsSchema,
  InvoiceSettingsResponseSchema,
  JobInvoicingResponseSchema,
  SendPreviewSchema,
  SendResponseSchema,
  type InvoiceSettingsOptions,
  type InvoiceSettingsResponse,
  type JobInvoicingResponse,
  type SendPreview,
  type SendResponse,
  type StageInput,
  type XeroContact,
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

// ── the job's client in Xero (#1149) ────────────────────────────────────────

/** Live search of the connected organisation's contacts (id + name only). */
export function searchXeroContacts(q: string): Promise<HttpResult<XeroContact[]>> {
  return httpGet(`${BASE}?action=contacts&q=${encodeURIComponent(q)}`, {
    schema: ContactSearchResponseSchema.transform((r) => r.contacts),
  });
}

/** Link the job to a Xero contact. The server re-reads the contact from Xero
 *  and stores Xero's own name for it. */
export function linkXeroContact(
  jobId: string,
  contactId: string,
  expectedVersion: number | null
): Promise<HttpResult<JobInvoicingResponse>> {
  return httpPut(`${BASE}?action=contact-link`, { jobId, contactId, expectedVersion }, opts);
}

export function unlinkXeroContact(
  jobId: string,
  expectedVersion: number
): Promise<HttpResult<JobInvoicingResponse>> {
  return httpPut(`${BASE}?action=contact-unlink`, { jobId, expectedVersion }, opts);
}

// ── invoice defaults (#1149) ────────────────────────────────────────────────

export function invoiceSettings(): Promise<HttpResult<InvoiceSettingsResponse>> {
  return httpGet(`${BASE}?action=settings`, { schema: InvoiceSettingsResponseSchema });
}

/** Read live from Xero: active revenue accounts and sales tax rates. */
export function invoiceSettingsOptions(): Promise<HttpResult<InvoiceSettingsOptions>> {
  return httpGet(`${BASE}?action=settings-options`, { schema: InvoiceSettingsOptionsSchema });
}

export function saveInvoiceSettings(input: {
  salesAccountCode: string;
  taxType: string;
  paymentTermsDays: number;
  expectedVersion: number | null;
}): Promise<HttpResult<InvoiceSettingsResponse>> {
  return httpPut(`${BASE}?action=settings`, input, { schema: InvoiceSettingsResponseSchema });
}

// ── sending to Xero (#1150) ─────────────────────────────────────────────────

const sendOpts = { schema: SendResponseSchema };
const stageUrl = (action: string, stageId: string) =>
  `${BASE}?action=${action}&id=${encodeURIComponent(stageId)}`;

/** Exactly what would be sent and everything stopping it. Writes nothing. */
export function previewSend(
  stageId: string,
  options: { invoiceDate?: string; reference?: string | null } = {}
): Promise<HttpResult<SendPreview>> {
  return httpPost(stageUrl("preview", stageId), options, { schema: SendPreviewSchema });
}

/** Create the stage in Xero as a DRAFT invoice. A slow Xero is not a failed
 *  send: the generous timeout keeps the browser waiting for the real answer. */
export function sendStage(
  stageId: string,
  input: { expectedVersion: number; invoiceDate?: string; reference?: string | null }
): Promise<HttpResult<SendResponse>> {
  return httpPost(stageUrl("send", stageId), input, { ...sendOpts, timeoutMs: 45_000 });
}

/** Look the stage's number up in Xero: adopt what is there, or send again. */
export function retrySend(stageId: string): Promise<HttpResult<SendResponse>> {
  return httpPost(stageUrl("retry", stageId), {}, { ...sendOpts, timeoutMs: 45_000 });
}

/** Put a stage that never reached Xero back to planned so it can be edited. */
export function resetSend(stageId: string): Promise<HttpResult<SendResponse>> {
  return httpPost(stageUrl("reset", stageId), {}, { ...sendOpts, timeoutMs: 45_000 });
}

/** The number is taken in Xero: add a planned copy that takes the next one. */
export function raiseAgain(stageId: string): Promise<HttpResult<JobInvoicingResponse>> {
  return httpPost(stageUrl("raise-again", stageId), {}, opts);
}

/** Add a planned stage that releases some of the retention held. */
export function addRetentionRelease(
  jobId: string,
  amountCents: number
): Promise<HttpResult<JobInvoicingResponse>> {
  return httpPost(`${BASE}?action=retention-release`, { jobId, amountCents }, opts);
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
