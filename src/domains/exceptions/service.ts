import {
  hoursExceptions,
  jobExceptions,
  materialExceptions,
  observationExceptions,
} from "./mappers";
import { isSafeActionHref } from "./routes";
import type {
  ExceptionFilters,
  ExceptionItem,
  ExceptionSeverity,
  ExceptionSources,
  ExceptionSummary,
} from "./types";

/**
 * The Exceptions Inbox projection: aggregate every source mapper, de-duplicate
 * by id, and sort deterministically (critical first, then oldest first, then by
 * id) so the same data always renders in the same order. Plus filtering and a
 * count summary for the UI.
 */

const SEVERITY_ORDER: Record<ExceptionSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/** Build the unified, sorted, de-duplicated exception list from sources. */
export function buildExceptions(sources: ExceptionSources): ExceptionItem[] {
  const all = [
    ...hoursExceptions(sources.hoursPending, sources.hoursRejected),
    ...observationExceptions(sources.observations),
    ...jobExceptions(sources.jobs),
    ...materialExceptions(sources.materialRequests),
  ];

  // De-dupe by id (first wins) — ids are unique by construction, but guard.
  const seen = new Set<string>();
  const deduped: ExceptionItem[] = [];
  for (const item of all) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }

  return deduped.sort(compareExceptions);
}

/**
 * Deterministic order: severity (critical→info), then oldest createdAt first
 * (items without a timestamp sort after dated ones), then id as a stable
 * tiebreaker so the sort never depends on input order.
 */
export function compareExceptions(a: ExceptionItem, b: ExceptionItem): number {
  const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (sev !== 0) return sev;
  const at = a.createdAt ?? "";
  const bt = b.createdAt ?? "";
  if (at && bt && at !== bt) return at < bt ? -1 : 1; // ISO sorts chronologically
  if (at && !bt) return -1;
  if (!at && bt) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function filterExceptions(
  items: ReadonlyArray<ExceptionItem>,
  filters: ExceptionFilters,
): ExceptionItem[] {
  return items.filter((it) => {
    if (filters.source && filters.source !== "all" && it.source !== filters.source) return false;
    if (filters.severity && filters.severity !== "all" && it.severity !== filters.severity) return false;
    if (filters.jobId && filters.jobId !== "all" && it.jobId !== filters.jobId) return false;
    return true;
  });
}

export function summariseExceptions(items: ReadonlyArray<ExceptionItem>): ExceptionSummary {
  const bySeverity: Record<ExceptionSeverity, number> = { critical: 0, warning: 0, info: 0 };
  const bySource: ExceptionSummary["bySource"] = {};
  for (const it of items) {
    bySeverity[it.severity] += 1;
    bySource[it.source] = (bySource[it.source] ?? 0) + 1;
  }
  return { total: items.length, bySeverity, bySource };
}

/** Distinct jobs present in the list, for the job filter dropdown. */
export function jobOptions(
  items: ReadonlyArray<ExceptionItem>,
): Array<{ jobId: string; jobName: string }> {
  const seen = new Map<string, string>();
  for (const it of items) {
    if (it.jobId && !seen.has(it.jobId)) {
      seen.set(it.jobId, it.jobName ?? it.jobId);
    }
  }
  return [...seen.entries()]
    .map(([jobId, jobName]) => ({ jobId, jobName }))
    .sort((a, b) => a.jobName.localeCompare(b.jobName));
}

// The canonical internal-href guard lives with the route registry (it's the
// same rule the registry uses). Re-exported so existing callers keep importing
// it from the service.
export { isSafeActionHref } from "./routes";

/**
 * Whether an item's action should render as a clickable link: it must be
 * `available` AND carry a safe internal href. Anything else renders as a muted
 * "unavailable" state — never a broken link.
 */
export function isActionable(item: ExceptionItem): boolean {
  return item.actionState === "available" && isSafeActionHref(item.actionHref);
}
