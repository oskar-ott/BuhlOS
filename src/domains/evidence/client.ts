import { httpGet, httpPost, type HttpResult } from "@/lib/http";
import {
  CreateEvidencePayloadSchema,
  EvidenceCreateResponseSchema,
  EvidenceListResponseSchema,
  EvidencePhotoUploadResponseSchema,
  EvidenceReviewResponseSchema,
  ReviewEvidencePayloadSchema,
} from "./schema";
import type {
  CreateEvidencePayload,
  EvidenceCreateResponse,
  EvidenceListResponse,
  EvidencePhotoUploadResponse,
  EvidenceReviewResponse,
  ReviewEvidencePayload,
} from "./types";

/**
 * Typed wrapper around /api/evidence (D2 endpoint).
 *
 *   GET  /api/evidence?jobId=<id>                  → list evidence for a job
 *   POST /api/evidence?jobId=<id>                  → create one evidence item
 *   POST /api/evidence?jobId=<id>&action=review    → admin review (D4 stub)
 *
 * Permissions are enforced server-side in api/evidence.js:
 *   - unauthenticated   → 401
 *   - role=client       → 403 (read-only role; D4 may revisit)
 *   - non-admin worker  → only assigned jobs (per assignedJobIds)
 *   - tradie sees only own captures on GET (per doc 24 §15.0 Decision 5)
 *   - admin sees all captures for the job
 *   - admin only on review (403 otherwise)
 *
 * The client validates the payload against the matching schema before
 * issuing fetch, so invalid bodies never hit the network — same
 * pattern as src/domains/timesheets/client.ts.
 *
 * Cross-ref:
 *   src/domains/timesheets/client.ts — precedent
 *   src/domains/jobs/client.ts — precedent
 *   src/lib/http.ts — schema-validating fetch helper
 *   api/evidence.js
 */

function evidenceUrl(jobId: string, action?: string): string {
  const base = `/api/evidence?jobId=${encodeURIComponent(jobId)}`;
  return action ? `${base}&action=${encodeURIComponent(action)}` : base;
}

export function listEvidence(
  jobId: string
): Promise<HttpResult<EvidenceListResponse>> {
  return httpGet<EvidenceListResponse>(evidenceUrl(jobId), {
    schema: EvidenceListResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

export function createEvidence(
  jobId: string,
  payload: CreateEvidencePayload
): Promise<HttpResult<EvidenceCreateResponse>> {
  const parsed = CreateEvidencePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.flatten(),
        message: `invalid evidence payload: ${parsed.error.message}`,
      },
    });
  }
  return httpPost<EvidenceCreateResponse>(evidenceUrl(jobId), parsed.data, {
    schema: EvidenceCreateResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

export function reviewEvidence(
  jobId: string,
  payload: ReviewEvidencePayload
): Promise<HttpResult<EvidenceReviewResponse>> {
  const parsed = ReviewEvidencePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.flatten(),
        message: `invalid review payload: ${parsed.error.message}`,
      },
    });
  }
  return httpPost<EvidenceReviewResponse>(evidenceUrl(jobId, "review"), parsed.data, {
    schema: EvidenceReviewResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

/**
 * Photo upload — POST /api/photos?jobId=X&action=upload-evidence-photo.
 *
 * Reuses the legacy photos endpoint's D2-added action branch. Returns
 * the canonical `{ id, url, capturedAt }` the D3 capture sheet then
 * passes into `createEvidence()` as `photoId` + `photoUrl`.
 *
 * Two-step capture (upload → create) is intentional per doc 24 §9:
 * the binary write needs to land before the metadata row references it.
 * D2-L2 covers the orphan-photo edge case (evidence create fails after
 * upload succeeds; manual blob cleanup acceptable for D2 onwards).
 *
 * Client must encode the image as a `data:image/...;base64,...` URL.
 * D3 capture sheet uses `src/domains/evidence/service.ts#resizeImageToDataUrl`
 * to produce a compliant dataUrl ≤ 6 MB.
 */
export function uploadEvidencePhoto(
  jobId: string,
  dataUrl: string
): Promise<HttpResult<EvidencePhotoUploadResponse>> {
  const url = `/api/photos?jobId=${encodeURIComponent(jobId)}&action=upload-evidence-photo`;
  return httpPost<EvidencePhotoUploadResponse>(
    url,
    { dataUrl },
    {
      schema: EvidencePhotoUploadResponseSchema,
      init: { cache: "no-store", credentials: "same-origin" },
    }
  );
}

export const evidenceClient = {
  listEvidence,
  createEvidence,
  reviewEvidence,
  uploadEvidencePhoto,
} as const;
