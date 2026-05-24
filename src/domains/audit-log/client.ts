import { httpGet, type HttpResult } from "@/lib/http";
import { AuditLogListResponseSchema } from "./schema";
import type { AuditLogEntry, AuditLogListResponse } from "./types";

/**
 * Read-only client surface for the audit log.
 *
 * D2 shipped the storage + write path (via api/_lib/audit-log.js,
 * called from api/evidence.js). D5 ships the GET read endpoint
 * (api/audit-log.js) plus the typed wrapper below; the D4 evidence
 * drawer's History section now consumes real data instead of the
 * earlier UC placeholder.
 *
 * No append() / update() / delete() functions exist here by design —
 * the audit log is append-only and only the server writes to it.
 */

/**
 * GET /api/audit-log?targetType=evidence&targetId=X&jobId=X
 *
 * The server filters by targetType + targetId + jobId, applies the
 * role-based visibility rule (tradie sees own activity / activity
 * about own captures), and returns entries newest-first.
 *
 * `months` defaults to 2 server-side (scans 2 recent monthly blobs).
 * Pass a higher number to read further back; the server caps at 12.
 */
export function listAuditForTarget(args: {
  jobId: string;
  targetType: "evidence";
  targetId: string;
  months?: number;
}): Promise<HttpResult<AuditLogListResponse>> {
  const params = new URLSearchParams({
    jobId: args.jobId,
    targetType: args.targetType,
    targetId: args.targetId,
  });
  if (typeof args.months === "number" && Number.isFinite(args.months)) {
    params.set("months", String(Math.max(1, Math.floor(args.months))));
  }
  return httpGet<AuditLogListResponse>(`/api/audit-log?${params.toString()}`, {
    schema: AuditLogListResponseSchema,
    init: { cache: "no-store", credentials: "same-origin" },
  });
}

export const auditLogClient = {
  listAuditForTarget,
  sortNewestFirst,
  entriesForTarget,
  monthBucket,
} as const;

/**
 * Filter helper: return entries newest-first. Stable sort so two rows
 * with the same `ts` keep their original insertion order.
 */
export function sortNewestFirst(entries: ReadonlyArray<AuditLogEntry>): AuditLogEntry[] {
  return entries
    .slice()
    .sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
}

/**
 * Filter helper: return entries about a single target (evidenceId).
 * Used by the D4 admin drawer to show "capture → reviewed → rejected"
 * history for one EvidenceItem.
 */
export function entriesForTarget(
  entries: ReadonlyArray<AuditLogEntry>,
  targetType: string,
  targetId: string
): AuditLogEntry[] {
  return entries.filter(
    (e) => e.targetType === targetType && e.targetId === targetId
  );
}

/**
 * yyyy-mm bucket for a given ISO timestamp. The audit storage rolls
 * over each calendar month so the read path can scope by month.
 *
 *   monthBucket("2026-05-24T08:00:00.000Z") → "2026-05"
 *   monthBucket("nonsense")                 → ""
 */
const YYYY_MM = /^\d{4}-\d{2}/;
export function monthBucket(iso: string): string {
  if (typeof iso !== "string" || iso.length < 7) return "";
  if (!YYYY_MM.test(iso)) return "";
  return iso.slice(0, 7);
}
