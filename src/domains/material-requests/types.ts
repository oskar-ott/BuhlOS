import type { z } from "zod";
import type {
  CreateMaterialRequestPayloadSchema,
  MaterialRequestItemSchema,
  MaterialRequestListResponseSchema,
  MaterialRequestMutationResponseSchema,
  MaterialRequestSourceSchema,
  MaterialRequestStageSchema,
  MaterialRequestStatusSchema,
  MaterialRequestUrgencySchema,
  UpdateMaterialRequestPayloadSchema,
} from "./schema";

/**
 * Inferred types for the material-requests domain. Cross-ref:
 * src/domains/snags/types.ts — direct precedent.
 */

export type MaterialRequestStatus = z.infer<typeof MaterialRequestStatusSchema>;
export type MaterialRequestUrgency = z.infer<typeof MaterialRequestUrgencySchema>;
export type MaterialRequestSource = z.infer<typeof MaterialRequestSourceSchema>;
export type MaterialRequestStage = z.infer<typeof MaterialRequestStageSchema>;

export type MaterialRequestItem = z.infer<typeof MaterialRequestItemSchema>;
export type CreateMaterialRequestPayload = z.infer<typeof CreateMaterialRequestPayloadSchema>;
export type UpdateMaterialRequestPayload = z.infer<typeof UpdateMaterialRequestPayloadSchema>;

export type MaterialRequestListResponse = z.infer<typeof MaterialRequestListResponseSchema>;
export type MaterialRequestMutationResponse = z.infer<typeof MaterialRequestMutationResponseSchema>;
