import type { z } from "zod";
import type {
  CreateEvidencePayloadSchema,
  EvidenceCreateResponseSchema,
  EvidenceItemSchema,
  EvidenceKindSchema,
  EvidenceListResponseSchema,
  EvidencePhotoUploadResponseSchema,
  EvidenceReviewResponseSchema,
  EvidenceSourceSchema,
  EvidenceStageSchema,
  EvidenceStatusSchema,
  ReviewEvidencePayloadSchema,
  ServerEvidenceStatusSchema,
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

export type EvidenceListResponse = z.infer<typeof EvidenceListResponseSchema>;
export type EvidenceCreateResponse = z.infer<typeof EvidenceCreateResponseSchema>;
export type EvidenceReviewResponse = z.infer<typeof EvidenceReviewResponseSchema>;
export type EvidencePhotoUploadResponse = z.infer<typeof EvidencePhotoUploadResponseSchema>;
