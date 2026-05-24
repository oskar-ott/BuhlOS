import type { AuditLogEntry } from "./types";

/**
 * Read-only client surface for the audit log.
 *
 * D2 ships the storage + write path (via api/_lib/audit-log.js, called
 * from api/evidence.js). The cross-surface read endpoint lands in D4
 * (admin audit drawer); until then this file exports only the pure
 * helpers components will need when D4 surfaces the data.
 *
 * No append() / update() / delete() functions exist here by design —
 * the audit log is append-only and only the server writes to it.
 */

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
