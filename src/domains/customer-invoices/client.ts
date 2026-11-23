import { httpGet, httpPost, httpPut, type HttpResult } from "@/lib/http";
import {
  ContactSearchResponseSchema,
  InvoiceSettingsOptionsSchema,
  InvoiceSettingsResponseSchema,
  JobInvoicingResponseSchema,
  RefreshResponseSchema,
  SendPreviewSchema,
  SendResponseSchema,
  BillableResponseSchema,
  InvoicePrefsResponseSchema,
  type BillableResponse,
  type InvoicePrefs,
  type ItemisedInput,
  type VariationInput,
  type InvoiceSettingsOptions,
  type InvoiceSettingsResponse,
  type JobInvoicingResponse,
  type RefreshResponse,
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

// ── paid status (#1151) ─────────────────────────────────────────────────────

/** "Check Xero now": ask Xero what happened to this job's sent invoices. */
export function refreshJobInvoices(jobId: string): Promise<HttpResult<RefreshResponse>> {
  return httpPost(`${BASE}?action=refresh`, { jobId }, { schema: RefreshResponseSchema, timeoutMs: 45_000 });
}

// ── itemised invoices (#1161) ───────────────────────────────────────────────

/** Add a planned ITEMISED invoice: lines with a quantity and a unit price. */
export function addItemised(
  jobId: string,
  stage: ItemisedInput
): Promise<HttpResult<JobInvoicingResponse>> {
  return httpPost(`${BASE}?action=stage-add`, { jobId, stage }, { ...opts, timeoutMs: 30_000 });
}

export function editItemised(
  stageId: string,
  stage: ItemisedInput,
  expectedVersion: number
): Promise<HttpResult<JobInvoicingResponse>> {
  return httpPost(
    `${BASE}?action=stage-edit&id=${encodeURIComponent(stageId)}`,
    { stage, expectedVersion },
    { ...opts, timeoutMs: 30_000 }
  );
}

// ── what on the job can go on an invoice (#1162) ────────────────────────────

/** The job's approved hours and materials, each marked with the invoice it is
 *  already on. `invoiceId` is the invoice being edited — its own lines don't
 *  count against it. Reads every time sheet, so it gets a longer wait. */
export function jobBillable(
  jobId: string,
  invoiceId?: string | null
): Promise<HttpResult<BillableResponse>> {
  const q = `${BASE}?action=billable&jobId=${encodeURIComponent(jobId)}${invoiceId ? `&invoiceId=${encodeURIComponent(invoiceId)}` : ""}`;
  return httpGet(q, { schema: BillableResponseSchema, timeoutMs: 30_000 });
}

export function saveInvoicePrefs(input: {
  materialsMarkupBp: number | null;
  labourRoundMinutes: number;
  usualCharges: Array<{ id?: string; name: string; unit?: string | null; unitCents: number; kind: "labour" | "other" }>;
  expectedVersion: number | null;
}): Promise<HttpResult<InvoicePrefs>> {
  return httpPut(`${BASE}?action=prefs`, input, {
    schema: InvoicePrefsResponseSchema.transform((r) => r.prefs),
  });
}

// ── variations (#1163) ──────────────────────────────────────────────────────

const variationUrl = (action: string, id: string) => `${BASE}?action=${action}&id=${encodeURIComponent(id)}`;

export function addVariation(jobId: string, variation: VariationInput): Promise<HttpResult<JobInvoicingResponse>> {
  return httpPost(`${BASE}?action=variation-add`, { jobId, variation }, opts);
}

export function editVariation(
  id: string,
  variation: VariationInput,
  expectedVersion: number
): Promise<HttpResult<JobInvoicingResponse>> {
  return httpPost(variationUrl("variation-edit", id), { variation, expectedVersion }, opts);
}

/** Approve (with the approved amount), decline, or put back to proposed. */
export function decideVariation(
  id: string,
  input: {
    status: "approved" | "declined" | "proposed";
    approvedCents?: number | null;
    approvalRef?: string | null;
    decidedOn?: string | null;
    expectedVersion: number;
  }
): Promise<HttpResult<JobInvoicingResponse>> {
  return httpPost(variationUrl("variation-decide", id), input, opts);
}

export function removeVariation(id: string, expectedVersion: number): Promise<HttpResult<JobInvoicingResponse>> {
  return httpPost(variationUrl("variation-remove", id), { expectedVersion }, opts);
}

/** Put an approved variation on a planned stage, or — with no stage — on an
 *  invoice of its own. */
export function billVariation(
  id: string,
  target?: { stageId: string; expectedStageVersion: number }
): Promise<HttpResult<JobInvoicingResponse>> {
  return httpPost(variationUrl("variation-bill", id), target ?? {}, opts);
}

// ── payment-claim wording (#1164) ───────────────────────────────────────────

export function setPaymentClaim(
  jobId: string,
  on: boolean,
  expectedVersion: number | null
): Promise<HttpResult<JobInvoicingResponse>> {
  return httpPut(`${BASE}?action=payment-claim`, { jobId, on, expectedVersion }, opts);
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
