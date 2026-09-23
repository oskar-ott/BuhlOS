import { httpGet, httpPost, httpPut, type HttpResult } from "@/lib/http";
import {
  InvoiceDetailSchema,
  InvoiceListSchema,
  InvoiceSetupSchema,
  JobInvoiceSummarySchema,
  JobMaterialsBreakdownSchema,
  type JobMaterialsBreakdown,
  type MaterialCategory,
  JobPickerSchema,
  ProcessPendingSchema,
  type InvoiceDetail,
  type InvoiceList,
  type InvoiceSetup,
  type JobInvoiceSummary,
  type JobSummary,
} from "./schema";

/**
 * Typed client for /api/invoices (supplier-invoice capture). Admin-tier and
 * flag-gated on the server: a 403/404 surfaces as an HttpResult error, never
 * silently empty. Money is integer cents — display divides by 100.
 */

const BASE = "/api/invoices";

export interface InvoiceListFilters {
  status?: string[];
  supplier?: string;
  jobId?: string;
  from?: string;
  to?: string;
  q?: string;
  autoConfirm?: "pending";
  page?: number;
  limit?: number;
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === "") continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function listInvoices(f: InvoiceListFilters = {}): Promise<HttpResult<InvoiceList>> {
  return httpGet(
    `${BASE}${qs({
      status: f.status && f.status.length ? f.status.join(",") : undefined,
      supplier: f.supplier,
      jobId: f.jobId,
      from: f.from,
      to: f.to,
      q: f.q,
      autoConfirm: f.autoConfirm,
      page: f.page,
      limit: f.limit,
    })}`,
    { schema: InvoiceListSchema }
  );
}

export function getInvoice(id: string): Promise<HttpResult<InvoiceDetail>> {
  return httpGet(`${BASE}${qs({ id })}`, { schema: InvoiceDetailSchema });
}

export function invoiceSetup(): Promise<HttpResult<InvoiceSetup>> {
  return httpGet(`${BASE}?action=setup`, { schema: InvoiceSetupSchema });
}

export function searchJobs(q: string): Promise<HttpResult<{ jobs: JobSummary[] }>> {
  return httpGet(`${BASE}${qs({ action: "jobs", q })}`, { schema: JobPickerSchema });
}

export function jobMaterialsBreakdown(jobId: string): Promise<HttpResult<JobMaterialsBreakdown>> {
  return httpGet(`${BASE}${qs({ action: "job-materials", jobId })}`, { schema: JobMaterialsBreakdownSchema });
}

/** Re-file (or rename) one line item; the category is remembered for this supplier + product. */
export function correctInvoiceLine(id: string, patch: { lineNo: number; category?: MaterialCategory; description?: string; remember?: boolean }): Promise<HttpResult<InvoiceDetail>> {
  return httpPut(`${BASE}${qs({ action: "line", id })}`, patch, { schema: InvoiceDetailSchema, timeoutMs: 20_000 });
}

export function jobInvoiceSummary(jobId: string): Promise<HttpResult<JobInvoiceSummary>> {
  return httpGet(`${BASE}${qs({ action: "job-summary", jobId })}`, { schema: JobInvoiceSummarySchema });
}

/** The authenticated PDF proxy URL (never a raw Blob URL). */
export function invoiceDocumentUrl(id: string, documentId?: string): string {
  return `${BASE}${qs({ action: "document", id, documentId })}`;
}

export function uploadInvoice(input: { filename: string; dataUrl: string }): Promise<HttpResult<InvoiceDetail>> {
  return httpPost(`${BASE}?action=upload`, input, { schema: InvoiceDetailSchema, timeoutMs: 60_000 });
}

export function processPending(): Promise<HttpResult<{ processed: Array<{ id: string; status: string }> }>> {
  return httpPost(`${BASE}?action=process-pending`, {}, { schema: ProcessPendingSchema, timeoutMs: 60_000 });
}

export interface InvoiceCorrections {
  supplierName?: string;
  supplierInvoiceNumber?: string | null;
  documentType?: string;
  invoiceDate?: string | null;
  subtotalCents?: number | null;
  gstCents?: number | null;
  totalCents?: number | null;
  ivReference?: string | null;
}

export function correctInvoice(id: string, patch: InvoiceCorrections): Promise<HttpResult<InvoiceDetail>> {
  return httpPut(`${BASE}${qs({ id })}`, patch, { schema: InvoiceDetailSchema, timeoutMs: 20_000 });
}

function act(action: string, id: string, body: unknown = {}, timeoutMs = 20_000): Promise<HttpResult<InvoiceDetail>> {
  return httpPost(`${BASE}${qs({ action, id })}`, body, { schema: InvoiceDetailSchema, timeoutMs });
}

export const selectInvoiceJob = (id: string, jobId: string) => act("select-job", id, { jobId });
export const confirmInvoice = (id: string, jobId?: string) => act("confirm", id, jobId ? { jobId } : {});
export const reassignInvoice = (id: string, jobId: string) => act("reassign", id, { jobId });
export const markInvoiceDuplicate = (id: string, duplicateOfId?: string) =>
  act("mark-duplicate", id, duplicateOfId ? { duplicateOfId } : {});
export const excludeInvoice = (id: string, reason?: string) => act("exclude", id, reason ? { reason } : {});
export const archiveInvoice = (id: string) => act("archive", id);
export const restoreInvoice = (id: string) => act("restore", id);
export const retryInvoice = (id: string) => act("retry", id, {}, 60_000);
export const holdInvoice = (id: string) => act("hold", id);
/** Give a record that arrived without a usable document its PDF or photo; the server re-reads it. */
export const attachInvoiceDocument = (id: string, input: { filename: string; dataUrl: string }) =>
  act("attach", id, input, 60_000);
export const setSupplierAlwaysReview = (id: string, alwaysReview: boolean) => act("supplier-pref", id, { alwaysReview });
