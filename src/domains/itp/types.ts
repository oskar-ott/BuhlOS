import type { z } from "zod";
import type {
  ArchiveITPPayloadSchema,
  AttachITPPayloadSchema,
  ITPArchiveResponseSchema,
  ITPAttachResponseSchema,
  ITPInstanceResultSchema,
  ITPInstanceSchema,
  ITPListResponseSchema,
  ITPPointTypeSchema,
  ITPScopeSchema,
  ITPStatusSchema,
  ITPTemplatePointSchema,
  ITPTemplateSchema,
  ITPTemplateSnapshotSchema,
  ITPTransitionResponseSchema,
  ITPWitnessRoleSchema,
  RecordITPPointPayloadSchema,
  ReopenITPPayloadSchema,
  SignOffITPPayloadSchema,
} from "./schema";

/**
 * Inferred types for the ITP domain. Components / API callers import
 * these — never the Zod schemas — so the validation layer stays an
 * implementation detail of the client / server.
 *
 * Cross-ref:
 *   src/domains/snags/types.ts — precedent
 */

export type ITPPointType = z.infer<typeof ITPPointTypeSchema>;
export type ITPWitnessRole = z.infer<typeof ITPWitnessRoleSchema>;
export type ITPScope = z.infer<typeof ITPScopeSchema>;
export type ITPStatus = z.infer<typeof ITPStatusSchema>;

export type ITPTemplatePoint = z.infer<typeof ITPTemplatePointSchema>;
export type ITPTemplateSnapshot = z.infer<typeof ITPTemplateSnapshotSchema>;
export type ITPTemplate = z.infer<typeof ITPTemplateSchema>;
export type ITPInstanceResult = z.infer<typeof ITPInstanceResultSchema>;
export type ITPInstance = z.infer<typeof ITPInstanceSchema>;

export type AttachITPPayload = z.infer<typeof AttachITPPayloadSchema>;
export type RecordITPPointPayload = z.infer<typeof RecordITPPointPayloadSchema>;
export type SignOffITPPayload = z.infer<typeof SignOffITPPayloadSchema>;
export type ReopenITPPayload = z.infer<typeof ReopenITPPayloadSchema>;
export type ArchiveITPPayload = z.infer<typeof ArchiveITPPayloadSchema>;

export type ITPListResponse = z.infer<typeof ITPListResponseSchema>;
export type ITPAttachResponse = z.infer<typeof ITPAttachResponseSchema>;
export type ITPTransitionResponse = z.infer<typeof ITPTransitionResponseSchema>;
export type ITPArchiveResponse = z.infer<typeof ITPArchiveResponseSchema>;
