import { z } from "zod";
import { httpPost, type HttpError, type HttpResult } from "@/lib/http";
import { EvidenceItemSchema } from "@/domains/evidence/schema";

/**
 * Typed wrappers for the #262 / #267 AI actions on /api/evidence.
 *
 *   POST ?jobId=X&action=classify                   { evidenceIds: [..≤8] }
 *   POST ?jobId=X&action=labels                     { evidenceId, add/accept/remove }
 *   POST ?jobId=X&action=dismiss-defect-suggestion  { evidenceId }
 *
 * All three are admin-tier and flag-gated server-side (ai_photo_labels /
 * ai_snag_suggestions — 404 while dark). Same httpPost + Zod pattern as
 * src/domains/evidence/client.ts; kept beside the only consumers (the
 * admin evidence queue/drawer) for this UI slice — fold into the domain
 * client when the domain layer next changes.
 *
 * Accepting a defect suggestion is NOT here on purpose: it rides the
 * EXISTING snag creation path (src/domains/snags/client.ts#createSnag
 * with evidenceIds) — no parallel write path (#267).
 */

export const CLASSIFY_BATCH_MAX = 8;

const ClassifyResultSchema = z
  .object({
    evidenceId: z.string(),
    outcome: z.enum(["labelled", "no-labels", "skipped", "failed"]),
    reason: z.string().optional(),
    labelCount: z.number().optional(),
  })
  .passthrough();

export const ClassifyEvidenceResponseSchema = z.object({
  results: z.array(ClassifyResultSchema),
  /** Only the rows the run actually changed — merge these into local state. */
  evidence: z.array(EvidenceItemSchema),
});

export type ClassifyResult = z.infer<typeof ClassifyResultSchema>;
export type ClassifyEvidenceResponse = z.infer<typeof ClassifyEvidenceResponseSchema>;

const EvidenceItemResponseSchema = z.object({ evidenceItem: EvidenceItemSchema });
export type EvidenceItemResponse = z.infer<typeof EvidenceItemResponseSchema>;

export interface LabelCorrectionPayload {
  evidenceId: string;
  add?: string[];
  accept?: string[];
  remove?: string[];
}

function evidenceUrl(jobId: string, action: string): string {
  return `/api/evidence?jobId=${encodeURIComponent(jobId)}&action=${encodeURIComponent(action)}`;
}

/**
 * Batch-classify photos (≤ CLASSIFY_BATCH_MAX). The server runs the
 * photos sequentially through the vision model, so the budget is
 * generous — but bounded, so a stuck call still fails honestly (#139).
 * A 503 {code:'UNCONFIGURED'} means no ANTHROPIC_API_KEY — surface the
 * error text plainly, never a fake result.
 */
export function classifyEvidencePhotos(
  jobId: string,
  evidenceIds: string[]
): Promise<HttpResult<ClassifyEvidenceResponse>> {
  return httpPost<ClassifyEvidenceResponse>(
    evidenceUrl(jobId, "classify"),
    { evidenceIds },
    {
      schema: ClassifyEvidenceResponseSchema,
      init: { cache: "no-store", credentials: "same-origin" },
      timeoutMs: 120000,
    }
  );
}

/** Human label correction — accept / remove / add (taxonomy-restricted server-side). */
export function correctEvidenceLabels(
  jobId: string,
  payload: LabelCorrectionPayload
): Promise<HttpResult<EvidenceItemResponse>> {
  return httpPost<EvidenceItemResponse>(evidenceUrl(jobId, "labels"), payload, {
    schema: EvidenceItemResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
    timeoutMs: 15000,
  });
}

/** Sticky dismissal of the AI defect→snag suggestion (#267). Idempotent. */
export function dismissDefectSuggestion(
  jobId: string,
  evidenceId: string
): Promise<HttpResult<EvidenceItemResponse>> {
  return httpPost<EvidenceItemResponse>(
    evidenceUrl(jobId, "dismiss-defect-suggestion"),
    { evidenceId },
    {
      schema: EvidenceItemResponseSchema,
      init: { cache: "no-store", credentials: "same-origin" },
      timeoutMs: 15000,
    }
  );
}

/**
 * Pull the server's honest error copy out of an HttpResult error —
 * api/evidence.js always ships `{ error: "…" }` bodies (e.g. the 503
 * "AI is not configured"). Falls back to the caller's copy.
 */
export function apiErrorMessage(error: HttpError, fallback: string): string {
  const body = error.body;
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    typeof (body as { error: unknown }).error === "string"
  ) {
    return (body as { error: string }).error;
  }
  return error.status === 0 && error.message ? error.message : fallback;
}
