import type { z } from "zod";
import type {
  CredentialSchema,
  CredentialStatusSchema,
  CredentialListResponseSchema,
  LicenceTypeSchema,
  AddCredentialPayloadSchema,
  UpdateCredentialPayloadSchema,
} from "./schema";

export type Credential = z.infer<typeof CredentialSchema>;
export type CredentialStatus = z.infer<typeof CredentialStatusSchema>;
export type CredentialListResponse = z.infer<typeof CredentialListResponseSchema>;
export type LicenceType = z.infer<typeof LicenceTypeSchema>;
export type AddCredentialPayload = z.infer<typeof AddCredentialPayloadSchema>;
export type UpdateCredentialPayload = z.infer<typeof UpdateCredentialPayloadSchema>;
