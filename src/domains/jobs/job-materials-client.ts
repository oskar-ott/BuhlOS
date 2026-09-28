import { z } from "zod";
import { httpDelete, httpGet, httpPost, type HttpError, type HttpResult } from "@/lib/http";

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
    /** Optional (2026-09-27): the docket / supplier invoice number as typed. */
    reference: z.string().nullable().optional(),
    /** Present only when the line was added despite a "Possible duplicate
     *  cost" warning — who, when, why, and which confirmed invoices it named. */
    duplicateOverride: z
      .object({
        reason: z.string(),
        invoiceIds: z.array(z.string()),
        strength: z.string().optional(),
        checkedAt: z.string(),
        by: z.string(),
        byName: z.string(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type MaterialsLine = z.infer<typeof MaterialsLineSchema>;

/** One confirmed supplier invoice the typed line may duplicate (server-ranked, strongest first). */
export const DuplicateCandidateSchema = z
  .object({
    invoiceId: z.string(),
    strength: z.enum(["reference", "amount_date"]),
    supplierName: z.string().nullable(),
    supplierInvoiceNumber: z.string().nullable(),
    amountCents: z.number().int(),
    invoiceDate: z.string().nullable(),
    reasons: z.array(z.string()),
  })
  .passthrough();
export type DuplicateCandidate = z.infer<typeof DuplicateCandidateSchema>;

const PossibleDuplicateBodySchema = z
  .object({ error: z.literal("possible_duplicate"), candidates: z.array(DuplicateCandidateSchema) })
  .passthrough();

/**
 * A 409 from POST /api/job-materials that means "this looks like a confirmed
 * supplier invoice already booked on the job" — the caller shows the warning
 * and may re-submit with `override: { reason }`. Any other error → null.
 */
export function parsePossibleDuplicate(error: HttpError): DuplicateCandidate[] | null {
  if (error.status !== 409) return null;
  const parsed = PossibleDuplicateBodySchema.safeParse(error.body);
  return parsed.success ? parsed.data.candidates : null;
}

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
  /** Docket / supplier invoice number (optional) — the strongest duplicate signal. */
  reference?: string | null;
  amountCents: number;
  /** Add despite a "Possible duplicate cost" warning; the reason is mandatory and audited. */
  override?: { reason: string } | null;
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
