import type { z } from "zod";
import type {
  DocumentCategorySchema,
  DocumentListResponseSchema,
  DocumentSchema,
  DocumentStatusSchema,
  UploadDocumentPayloadSchema,
  UploadDocumentResponseSchema,
  SetPagesResponseSchema,
} from "./schema";

/**
 * Inferred types for the documents domain. Components + API callers
 * import these — never the Zod schemas — so the validation layer
 * stays an implementation detail of the client/server.
 *
 * Cross-ref:
 *   src/domains/itp/types.ts — precedent
 */

export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;
export type DocumentCategory = z.infer<typeof DocumentCategorySchema>;
export type Document = z.infer<typeof DocumentSchema>;
export type DocumentListResponse = z.infer<typeof DocumentListResponseSchema>;
export type UploadDocumentPayload = z.infer<typeof UploadDocumentPayloadSchema>;
export type UploadDocumentResponse = z.infer<typeof UploadDocumentResponseSchema>;
export type SetPagesResponse = z.infer<typeof SetPagesResponseSchema>;
