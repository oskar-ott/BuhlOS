import type { z } from "zod";
import type {
  CreateServiceLocationPayloadSchema,
  ServiceLocationListResponseSchema,
  ServiceLocationPhotoSchema,
  ServiceLocationRecordSchema,
  ServiceLocationResponseSchema,
  ServiceLocationTypeSchema,
  UpdateServiceLocationPayloadSchema,
} from "./schema";

/**
 * Inferred types for the services-locations domain (#230). Components /
 * API callers import these — never the Zod schemas — so the validation
 * layer stays an implementation detail of the client / server.
 *
 * Cross-ref:
 *   src/domains/snags/types.ts — precedent
 *   src/domains/contacts/schema.ts — precedent
 */

export type ServiceLocationType = z.infer<typeof ServiceLocationTypeSchema>;
export type ServiceLocationPhoto = z.infer<typeof ServiceLocationPhotoSchema>;
export type ServiceLocationRecord = z.infer<typeof ServiceLocationRecordSchema>;

export type CreateServiceLocationPayload = z.infer<
  typeof CreateServiceLocationPayloadSchema
>;
export type UpdateServiceLocationPayload = z.infer<
  typeof UpdateServiceLocationPayloadSchema
>;

export type ServiceLocationListResponse = z.infer<
  typeof ServiceLocationListResponseSchema
>;
export type ServiceLocationResponse = z.infer<
  typeof ServiceLocationResponseSchema
>;
