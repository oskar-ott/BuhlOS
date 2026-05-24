import type { z } from "zod";
import type {
  AppendAuditLogPayloadSchema,
  AuditActionSchema,
  AuditLogEntrySchema,
  AuditLogFileSchema,
  AuditLogListResponseSchema,
  AuditTargetTypeSchema,
} from "./schema";

/**
 * Inferred types for the audit-log domain. Components / API code
 * imports these — never the Zod schemas — so the validation layer
 * stays an implementation detail of the storage helper.
 */

export type AuditAction = z.infer<typeof AuditActionSchema>;
export type AuditTargetType = z.infer<typeof AuditTargetTypeSchema>;
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;
export type AuditLogFile = z.infer<typeof AuditLogFileSchema>;
export type AuditLogListResponse = z.infer<typeof AuditLogListResponseSchema>;
export type AppendAuditLogPayload = z.infer<typeof AppendAuditLogPayloadSchema>;
