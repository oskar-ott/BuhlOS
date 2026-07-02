import { z } from "zod";
import { httpGet, httpPost, type HttpError, type HttpResult } from "@/lib/http";
import {
  CreateEvidencePayloadSchema,
  EvidenceCreateResponseSchema,
  EvidenceFlagAsBuiltResponseSchema,
  EvidenceItemSchema,
  EvidenceLinkResponseSchema,
  EvidenceListResponseSchema,
  EvidencePhotoUploadResponseSchema,
  EvidenceReviewResponseSchema,
  FlagAsBuiltPayloadSchema,
  LinkEvidencePayloadSchema,
  ReviewEvidencePayloadSchema,
  UnlinkEvidencePayloadSchema,
} from "./schema";
import type {
  CreateEvidencePayload,
  EvidenceCreateResponse,
  EvidenceFlagAsBuiltResponse,
  EvidenceLinkResponse,
  EvidenceListResponse,
  EvidencePhotoUploadResponse,
  EvidenceReviewResponse,
  FlagAsBuiltPayload,
  LinkEvidencePayload,
  ReviewEvidencePayload,
  UnlinkEvidencePayload,
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
    timeoutMs: 15000, // small JSON metadata write — never hang (#139)
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
 * Link an AFTER photo to a BEFORE photo of the same spot (#263).
 *
 * POST /api/evidence?jobId=X&action=link  body { afterId, beforeId }.
 * The server writes pairedWithId on the AFTER only and returns the
 * canonical AFTER item. Permission: the AFTER's capturing worker OR an
 * admin (LH / others → 403). Idempotent: already-linked → 200 no-op.
 */
export function linkEvidence(
  jobId: string,
  payload: LinkEvidencePayload
): Promise<HttpResult<EvidenceLinkResponse>> {
  const parsed = LinkEvidencePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.flatten(),
        message: `invalid link payload: ${parsed.error.message}`,
      },
    });
  }
  return httpPost<EvidenceLinkResponse>(evidenceUrl(jobId, "link"), parsed.data, {
    schema: EvidenceLinkResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

/**
 * Unlink the AFTER photo's pairing (#263).
 *
 * POST /api/evidence?jobId=X&action=unlink  body { afterId }. Clears
 * pairedWithId on the AFTER only; never touches the BEFORE. Same
 * permission gate as link. Idempotent: already-null → 200 no-op.
 */
export function unlinkEvidence(
  jobId: string,
  payload: UnlinkEvidencePayload
): Promise<HttpResult<EvidenceLinkResponse>> {
  const parsed = UnlinkEvidencePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.flatten(),
        message: `invalid unlink payload: ${parsed.error.message}`,
      },
    });
  }
  return httpPost<EvidenceLinkResponse>(evidenceUrl(jobId, "unlink"), parsed.data, {
    schema: EvidenceLinkResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

/**
 * Flag / unflag a capture as part of the as-built handover record (#233).
 *
 * POST /api/evidence?jobId=X&action=flag-asbuilt  body { evidenceId, asBuilt }.
 * Returns the canonical flagged item. Permission asymmetry is enforced
 * server-side: the capturer may flag/unflag their OWN; an admin or a
 * leading-hand-on-the-job may flag ANY; admin may unflag. Idempotent: no
 * change → 200 no-op.
 */
export function flagAsBuiltEvidence(
  jobId: string,
  payload: FlagAsBuiltPayload
): Promise<HttpResult<EvidenceFlagAsBuiltResponse>> {
  const parsed = FlagAsBuiltPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: {
        status: 0,
        body: parsed.error.flatten(),
        message: `invalid flag-asbuilt payload: ${parsed.error.message}`,
      },
    });
  }
  return httpPost<EvidenceFlagAsBuiltResponse>(evidenceUrl(jobId, "flag-asbuilt"), parsed.data, {
    schema: EvidenceFlagAsBuiltResponseSchema,
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
      // Generous: a multi-MB photo on weak signal needs room, but must still
      // fail honestly rather than hang forever (#139).
      timeoutMs: 60000,
    }
  );
}

// ── AI actions (#262 / #267) ─────────────────────────────────────────────
//
// Typed wrappers for the AI actions on /api/evidence:
//
//   POST ?jobId=X&action=classify                   { evidenceIds: [..≤8] }
//   POST ?jobId=X&action=labels                     { evidenceId, add/accept/remove }
//   POST ?jobId=X&action=dismiss-defect-suggestion  { evidenceId }
//
// All three are admin-tier and flag-gated server-side (ai_photo_labels /
// ai_snag_suggestions — 404 while dark). Folded in from the former
// src/components/admin/evidence-ai-client.ts once the admin evidence
// queue/drawer UI slice landed.
//
// Accepting a defect suggestion is NOT here on purpose: it rides the
// EXISTING snag creation path (src/domains/snags/client.ts#createSnag
// with evidenceIds) — no parallel write path (#267).

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

export const evidenceClient = {
  listEvidence,
  createEvidence,
  reviewEvidence,
  linkEvidence,
  unlinkEvidence,
  uploadEvidencePhoto,
} as const;
