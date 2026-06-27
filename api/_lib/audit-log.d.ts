// Type declarations for the CommonJS audit-log journal (api/_lib/audit-log.js)
// so src/ server code (e.g. the proof-review route) can consume `append`
// type-checked. The action/target enums live in
// src/domains/audit-log/schema.ts (AUDIT_ACTIONS / AUDIT_TARGET_TYPES), kept in
// sync with VALID_ACTIONS / VALID_TARGET_TYPES in the JS by the schema tests.

export interface AppendAuditPayload {
  action: string;
  actorId: string;
  actorName: string;
  actorRole?: string | null;
  jobId?: string | null;
  targetType: string;
  targetId: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLogEntry {
  id: string;
  ts: string;
  action: string;
  actorId: string;
  actorName: string;
  actorRole: string | null;
  jobId: string | null;
  targetType: string;
  targetId: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

/** Append a single entry. Best-effort — invalid action/targetType resolves to
 *  null rather than throwing; callers wrap in try/catch. */
export declare function append(payload: AppendAuditPayload): Promise<AuditLogEntry | null>;
export declare function readMonth(yyyymm: string): Promise<AuditLogEntry[]>;
export declare const MAX_ENTRIES_PER_MONTH: number;
export declare const TRIM_TO_PER_MONTH: number;
