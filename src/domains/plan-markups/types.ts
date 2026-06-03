import type { z } from "zod";
import type {
  CreateMarkupPayloadSchema,
  DrawingMarkupSchema,
  MarkupListResponseSchema,
  MarkupMutationResponseSchema,
  MarkupPointSchema,
  MarkupToneSchema,
  MarkupTypeSchema,
  UpdateMarkupPayloadSchema,
} from "./schema";

export type MarkupType = z.infer<typeof MarkupTypeSchema>;
export type MarkupTone = z.infer<typeof MarkupToneSchema>;
export type MarkupPoint = z.infer<typeof MarkupPointSchema>;
export type DrawingMarkup = z.infer<typeof DrawingMarkupSchema>;
export type CreateMarkupPayload = z.infer<typeof CreateMarkupPayloadSchema>;
export type UpdateMarkupPayload = z.infer<typeof UpdateMarkupPayloadSchema>;
export type MarkupListResponse = z.infer<typeof MarkupListResponseSchema>;
export type MarkupMutationResponse = z.infer<typeof MarkupMutationResponseSchema>;
