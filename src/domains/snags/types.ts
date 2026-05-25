import type { z } from "zod";
import type {
  CreateSnagPayloadSchema,
  SnagCreateResponseSchema,
  SnagItemSchema,
  SnagListResponseSchema,
  SnagPrioritySchema,
  SnagSourceSchema,
  SnagStageSchema,
  SnagStatusSchema,
  SnagTransitionResponseSchema,
  TransitionSnagPayloadSchema,
} from "./schema";

/**
 * Inferred types for the snags domain. Components / API callers
 * import these — never the Zod schemas — so the validation layer
 * stays an implementation detail of the client / server.
 *
 * Cross-ref:
 *   src/domains/evidence/types.ts — precedent
 *   src/domains/jobs/types.ts — precedent
 */

export type SnagStatus = z.infer<typeof SnagStatusSchema>;
export type SnagPriority = z.infer<typeof SnagPrioritySchema>;
export type SnagSource = z.infer<typeof SnagSourceSchema>;
export type SnagStage = z.infer<typeof SnagStageSchema>;

export type SnagItem = z.infer<typeof SnagItemSchema>;
export type CreateSnagPayload = z.infer<typeof CreateSnagPayloadSchema>;
export type TransitionSnagPayload = z.infer<typeof TransitionSnagPayloadSchema>;

export type SnagListResponse = z.infer<typeof SnagListResponseSchema>;
export type SnagCreateResponse = z.infer<typeof SnagCreateResponseSchema>;
export type SnagTransitionResponse = z.infer<typeof SnagTransitionResponseSchema>;
