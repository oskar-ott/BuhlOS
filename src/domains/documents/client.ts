import { httpGet, httpPost, type HttpResult } from "@/lib/http";
import {
  DocumentListResponseSchema,
  SetPagesResponseSchema,
  UploadDocumentResponseSchema,
  AckMutationResponseSchema,
  MyAcksResponseSchema,
  PlanAcksRollupResponseSchema,
} from "./schema";
import type {
  DocumentListResponse,
  SetPagesResponse,
  UploadDocumentPayload,
  UploadDocumentResponse,
} from "./types";

/**
 * Typed read-only wrapper around /api/plans.
 *
 *   GET /api/plans?jobId=<id> → list documents the viewer can see
 *
 * E2 shipped read-only; #379 adds the WRITE verbs the legacy cutover
 * orphaned (the deleted admin estate was the only caller of upload +
 * set-pages): uploadDocument and setPlanPages. PATCH / soft-archive
 * stay out until their surfaces exist.
 *
 * Server permissions (api/plans.js:494-512):
 *   - anonymous           → 401
 *   - client              → 403
 *   - admin / boss / owner / manager / office / pm / estimator → all
 *   - LH / tradie / apprentice / labourer / electrician on an
 *     assigned job → 200 (server strips `status === 'archived'` for
 *     non-admin callers)
 *
 * Cross-ref:
 *   src/domains/itp/client.ts — precedent
 *   src/lib/http.ts — schema-validating fetch helper
 *   api/plans.js — GET handler
 */

function plansUrl(jobId: string): string {
  return `/api/plans?jobId=${encodeURIComponent(jobId)}`;
}

export function listDocuments(
  jobId: string,
): Promise<HttpResult<DocumentListResponse>> {
  return httpGet<DocumentListResponse>(plansUrl(jobId), {
    schema: DocumentListResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

/**
 * Upload a document (dataUrl ≤ 25 MB, PDF or image). The server may
 * auto-supersede a same-drawing-number current revision and says so via
 * `revisionWarning` (post-fact copy — the supersede has already happened).
 */
export function uploadDocument(
  jobId: string,
  payload: UploadDocumentPayload,
): Promise<HttpResult<UploadDocumentResponse>> {
  return httpPost<UploadDocumentResponse>(plansUrl(jobId), payload, {
    schema: UploadDocumentResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

/**
 * Register ONE rendered page PNG on a plan (#379 restores the takeoff/
 * overlay pipeline's ingestion). One page per call — a 180-DPI A1 PNG is
 * ~2 MB base64 against Vercel's 4.5 MB serverless body cap; the server
 * upserts by pageIndex so streaming pages is lossless.
 */
export function setPlanPages(
  jobId: string,
  planId: string,
  page: { pageIndex: number; pngDataUrl: string },
): Promise<HttpResult<SetPagesResponse>> {
  return httpPost<SetPagesResponse>(
    `/api/plans?jobId=${encodeURIComponent(jobId)}&id=${encodeURIComponent(planId)}&action=set-pages`,
    { pages: [page] },
    { schema: SetPagesResponseSchema, init: { cache: "no-store", credentials: "same-origin" } },
  );
}

/** #299: worker acknowledges a revision — self-only, assigned crew. */
export function ackRevision(
  jobId: string,
  planId: string,
): Promise<HttpResult<{ ack: { planId: string; userId: string; userName: string; ackAt: string }; already?: boolean }>> {
  return httpPost(
    `/api/plans?jobId=${encodeURIComponent(jobId)}&action=ack`,
    { planId },
    { schema: AckMutationResponseSchema, init: { cache: "no-store", credentials: "same-origin" } },
  );
}

/** #299: the viewer's own acked planIds on this job. */
export function myPlanAcks(jobId: string): Promise<HttpResult<{ planIds: string[] }>> {
  return httpGet(`/api/plans?jobId=${encodeURIComponent(jobId)}&action=my-acks`, {
    schema: MyAcksResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

/** #299: admin rollup — acked / outstanding for one revision. */
export function planAcks(
  jobId: string,
  planId: string,
): Promise<HttpResult<{ acked: Array<{ userId: string; userName: string; ackAt: string }>; outstanding: Array<{ userId: string; userName: string }> }>> {
  return httpGet(
    `/api/plans?jobId=${encodeURIComponent(jobId)}&action=acks&planId=${encodeURIComponent(planId)}`,
    { schema: PlanAcksRollupResponseSchema, init: { cache: "no-store", credentials: "same-origin" } },
  );
}

export const documentsClient = {
  listDocuments,
  uploadDocument,
  setPlanPages,
} as const;
