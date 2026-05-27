import { httpGet, type HttpResult } from "@/lib/http";
import { DocumentListResponseSchema } from "./schema";
import type { DocumentListResponse } from "./types";

/**
 * Typed read-only wrapper around /api/plans.
 *
 *   GET /api/plans?jobId=<id> → list documents the viewer can see
 *
 * E2 ships **read-only** — no upload, no PATCH, no soft-archive, no
 * AI-takeoff. Uploads / curation keep happening on the legacy
 * /admin/plans surface.
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

export const documentsClient = {
  listDocuments,
} as const;
