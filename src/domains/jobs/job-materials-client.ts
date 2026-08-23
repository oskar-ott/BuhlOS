import { z } from "zod";
import { httpDelete, httpGet, httpPost, type HttpResult } from "@/lib/http";

/**
 * Client for /api/job-materials — the per-job materials SPEND ledger (owner
 * pull 2026-08-23). Admin-tier only and flag-gated (`job_materials_spend`) on
 * the server: a 403/404 surfaces as an HttpResult error, never silently empty.
 * Money is integer cents — display divides by 100.
 */

export const MaterialsLineSchema = z
  .object({
    id: z.string(),
    date: z.string(),
    supplier: z.string(),
    description: z.string().nullable(),
    amountCents: z.number().int(),
    createdBy: z.string(),
    createdByName: z.string(),
    createdAt: z.string(),
  })
  .passthrough();
export type MaterialsLine = z.infer<typeof MaterialsLineSchema>;

export const MaterialsLedgerResponseSchema = z
  .object({
    jobId: z.string(),
    lines: z.array(MaterialsLineSchema),
    totalCents: z.number().int(),
    count: z.number().int(),
  })
  .passthrough();
export type MaterialsLedgerResponse = z.infer<typeof MaterialsLedgerResponseSchema>;

export interface MaterialsLineInput {
  /** YYYY-MM-DD */
  date: string;
  supplier: string;
  description: string | null;
  amountCents: number;
}

export function jobMaterials(jobId: string): Promise<HttpResult<MaterialsLedgerResponse>> {
  return httpGet(`/api/job-materials?jobId=${encodeURIComponent(jobId)}`, {
    schema: MaterialsLedgerResponseSchema,
  });
}

export function addMaterialsLine(
  jobId: string,
  input: MaterialsLineInput
): Promise<HttpResult<MaterialsLedgerResponse>> {
  return httpPost(`/api/job-materials?jobId=${encodeURIComponent(jobId)}`, input, {
    schema: MaterialsLedgerResponseSchema,
    timeoutMs: 15000,
  });
}

export function removeMaterialsLine(
  jobId: string,
  lineId: string
): Promise<HttpResult<MaterialsLedgerResponse>> {
  return httpDelete(
    `/api/job-materials?jobId=${encodeURIComponent(jobId)}&id=${encodeURIComponent(lineId)}`,
    { schema: MaterialsLedgerResponseSchema, timeoutMs: 15000 }
  );
}

/**
 * The Materials card and the Money card are separate client islands on a
 * server-rendered hub, so a ledger write announces itself on `window` and the
 * Money card refetches — no shared store, no page reload.
 */
export const JOB_MONEY_CHANGED_EVENT = "buhlos:job-money-changed";

export function announceJobMoneyChanged(jobId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(JOB_MONEY_CHANGED_EVENT, { detail: { jobId } }));
}
