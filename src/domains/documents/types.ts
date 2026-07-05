import type { z } from "zod";
import type {
  DocumentCategorySchema,
  DocumentListResponseSchema,
  DocumentSchema,
  DocumentStageSchema,
  DocumentStatusSchema,
  LinkDocumentAreasPayloadSchema,
  LinkDocumentAreasResponseSchema,
  SetDocumentVisibilityPayloadSchema,
  SetDocumentVisibilityResponseSchema,
  SuggestDocMetadataResponseSchema,
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
export type DocumentStage = z.infer<typeof DocumentStageSchema>;
export type Document = z.infer<typeof DocumentSchema>;
export type DocumentListResponse = z.infer<typeof DocumentListResponseSchema>;
export type UploadDocumentPayload = z.infer<typeof UploadDocumentPayloadSchema>;
export type UploadDocumentResponse = z.infer<typeof UploadDocumentResponseSchema>;
export type SetPagesResponse = z.infer<typeof SetPagesResponseSchema>;
export type LinkDocumentAreasPayload = z.infer<
  typeof LinkDocumentAreasPayloadSchema
>;
export type LinkDocumentAreasResponse = z.infer<
  typeof LinkDocumentAreasResponseSchema
>;
export type SetDocumentVisibilityPayload = z.infer<
  typeof SetDocumentVisibilityPayloadSchema
>;
export type SetDocumentVisibilityResponse = z.infer<
  typeof SetDocumentVisibilityResponseSchema
>;
export type SuggestDocMetadataResponse = z.infer<
  typeof SuggestDocMetadataResponseSchema
>;

/** Request body for suggestDocMetadata — the picked file as a data: URL plus
 *  the hints (fileName / mimeType) that sharpen the proposal. */
export interface SuggestDocMetadataPayload {
  dataUrl: string;
  fileName?: string;
  mimeType?: string;
}
