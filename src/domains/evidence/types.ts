import type { z } from "zod";
import type {
  CreateEvidencePayloadSchema,
  EvidenceCreateResponseSchema,
  EvidenceFlagAsBuiltResponseSchema,
  EvidenceItemSchema,
  EvidenceKindSchema,
  EvidenceLinkResponseSchema,
  EvidenceListResponseSchema,
  EvidencePhotoUploadResponseSchema,
  EvidenceReviewResponseSchema,
  EvidenceSourceSchema,
  EvidenceStageSchema,
  EvidenceStatusSchema,
  FlagAsBuiltPayloadSchema,
  LinkEvidencePayloadSchema,
  ReviewEvidencePayloadSchema,
  ServerEvidenceStatusSchema,
  UnlinkEvidencePayloadSchema,
} from "./schema";

/**
 * Inferred types for the evidence domain. Components and API callers
 * import these — never the Zod schemas — so the validation layer stays
 * an implementation detail of the client / server.
 *
 * Cross-ref:
 *   src/domains/timesheets/types.ts — precedent
 *   src/domains/jobs/types.ts — precedent
 */

export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;
export type EvidenceStage = z.infer<typeof EvidenceStageSchema>;
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;
export type ServerEvidenceStatus = z.infer<typeof ServerEvidenceStatusSchema>;
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
export type CreateEvidencePayload = z.infer<typeof CreateEvidencePayloadSchema>;
export type ReviewEvidencePayload = z.infer<typeof ReviewEvidencePayloadSchema>;
export type LinkEvidencePayload = z.infer<typeof LinkEvidencePayloadSchema>;
export type UnlinkEvidencePayload = z.infer<typeof UnlinkEvidencePayloadSchema>;
export type FlagAsBuiltPayload = z.infer<typeof FlagAsBuiltPayloadSchema>;

export type EvidenceListResponse = z.infer<typeof EvidenceListResponseSchema>;
export type EvidenceCreateResponse = z.infer<typeof EvidenceCreateResponseSchema>;
export type EvidenceReviewResponse = z.infer<typeof EvidenceReviewResponseSchema>;
export type EvidenceLinkResponse = z.infer<typeof EvidenceLinkResponseSchema>;
export type EvidenceFlagAsBuiltResponse = z.infer<typeof EvidenceFlagAsBuiltResponseSchema>;
export type EvidencePhotoUploadResponse = z.infer<typeof EvidencePhotoUploadResponseSchema>;
