import type { AuditLogEntry } from "@/domains/audit-log/types";

/**
 * Pure "recent activity" selection for the admin Job hub Overview.
 *
 * IMPORTANT — this does NOT build a timeline by merging records. BuhlOS
 * already has a real, append-only event store: the audit-log
 * (api/_lib/audit-log.js), surfaced per-job via
 * GET /api/audit-log?jobId=<id>&scope=job. That endpoint is what the full
 * /v2/jobs/[id]/history feed (JobActivityFeed) consumes, and it is already the
 * merged, chronologically-sorted stream of every evidence capture/review,
 * snag transition, ITP milestone, observation conversion and material-request
 * change on the job. Re-deriving a timeline from raw records here would
 * duplicate (and risk diverging from) that store — so the Overview card reads
 * the SAME source and this helper just trims it to the latest few.
 *
 * Pure (no fetch, no React). Sorts newest-first defensively (the API already
 * sorts desc, but we never trust input ordering) and reports `hasMore` so the
 * card can show an honest "+N more · view all" rather than implying the latest
 * five are everything.
 *
 * Cross-ref:
 *   api/_lib/audit-log.js — the append-only event store
 *   src/components/admin/JobActivityFeed.tsx — the full-page feed (history tab)
 *   src/components/admin/JobRecentActivity.tsx — the Overview consumer
 */

export interface RecentActivitySelection {
  items: AuditLogEntry[];
  /** Total events available (before the limit), for the "+N more" hint. */
  total: number;
  /** True when more events exist than the limit shows. */
  hasMore: boolean;
}

const DEFAULT_LIMIT = 5;

/**
 * Pick the newest `limit` audit-log events for the compact Overview card.
 * An invalid limit falls back to the default rather than throwing.
 */
export function selectRecentActivity(
  entries: ReadonlyArray<AuditLogEntry>,
  limit: number = DEFAULT_LIMIT,
): RecentActivitySelection {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { items: [], total: 0, hasMore: false };
  }
  const safeLimit =
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;
  const sorted = [...entries].sort((a, b) =>
    String(b.ts || "").localeCompare(String(a.ts || "")),
  );
  return {
    items: sorted.slice(0, safeLimit),
    total: entries.length,
    hasMore: entries.length > safeLimit,
  };
}
