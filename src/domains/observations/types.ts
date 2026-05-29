import type { z } from "zod";
import type {
  CreateObservationPayloadSchema,
  ObservationConvertTargetSchema,
  ObservationItemSchema,
  ObservationListResponseSchema,
  ObservationMutationResponseSchema,
  ObservationPrioritySchema,
  ObservationSourceSchema,
  ObservationStageSchema,
  ObservationStatusSchema,
  ObservationTypeSchema,
  UpdateObservationPayloadSchema,
} from "./schema";

/**
 * Inferred types for the observations domain. Components / API callers
 * import these — never the Zod schemas — so validation stays an
 * implementation detail of the client / server.
 *
 * Cross-ref: src/domains/snags/types.ts — precedent.
 */

export type ObservationType = z.infer<typeof ObservationTypeSchema>;
export type ObservationStatus = z.infer<typeof ObservationStatusSchema>;
export type ObservationPriority = z.infer<typeof ObservationPrioritySchema>;
export type ObservationSource = z.infer<typeof ObservationSourceSchema>;
export type ObservationStage = z.infer<typeof ObservationStageSchema>;
export type ObservationConvertTarget = z.infer<typeof ObservationConvertTargetSchema>;

export type ObservationItem = z.infer<typeof ObservationItemSchema>;
export type CreateObservationPayload = z.infer<typeof CreateObservationPayloadSchema>;
export type UpdateObservationPayload = z.infer<typeof UpdateObservationPayloadSchema>;

export type ObservationListResponse = z.infer<typeof ObservationListResponseSchema>;
export type ObservationMutationResponse = z.infer<typeof ObservationMutationResponseSchema>;
