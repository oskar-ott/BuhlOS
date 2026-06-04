import { isActionable } from "./service";
import { SOURCE_LABEL } from "./labels";
import type {
  ExceptionCounts,
  ExceptionItem,
  ExceptionJobGroup,
  ExceptionSeverity,
  ExceptionSource,
  ExceptionSourceGroup,
} from "./types";

/**
 * Pure grouping + rollup helpers for the operational inbox. Input order is
 * preserved within each group (callers pass an already-sorted list), and group
 * order is deterministic. No mutation.
 */

const SEVERITY_RANK: Record<ExceptionSeverity, number> = { critical: 0, warning: 1, info: 2 };
const GENERAL = "General";

function highestSeverity(items: ReadonlyArray<ExceptionItem>): ExceptionSeverity {
  let best: ExceptionSeverity = "info";
  for (const it of items) {
    if (SEVERITY_RANK[it.severity] < SEVERITY_RANK[best]) best = it.severity;
  }
  return best;
}

/**
 * Group items under their job; items with no jobId fall under "General".
 * Groups sort by highest severity (critical first), then job name; "General"
 * always sorts last.
 */
export function groupExceptionsByJob(items: ReadonlyArray<ExceptionItem>): ExceptionJobGroup[] {
  const map = new Map<string, ExceptionItem[]>();
  const names = new Map<string, { jobId: string | null; jobName: string }>();
  for (const it of items) {
    const key = it.jobId ?? "__general__";
    if (!map.has(key)) {
      map.set(key, []);
      names.set(key, {
        jobId: it.jobId ?? null,
        jobName: it.jobId ? (it.jobName ?? it.jobId) : GENERAL,
      });
    }
    map.get(key)!.push(it);
  }

  const groups: ExceptionJobGroup[] = [...map.entries()].map(([key, groupItems]) => ({
    jobId: names.get(key)!.jobId,
    jobName: names.get(key)!.jobName,
    items: groupItems,
    count: groupItems.length,
    highestSeverity: highestSeverity(groupItems),
  }));

  return groups.sort((a, b) => {
    const aGeneral = a.jobId === null;
    const bGeneral = b.jobId === null;
    if (aGeneral !== bGeneral) return aGeneral ? 1 : -1; // General last
    const sev = SEVERITY_RANK[a.highestSeverity] - SEVERITY_RANK[b.highestSeverity];
    if (sev !== 0) return sev;
    return a.jobName.localeCompare(b.jobName);
  });
}

/** Group items by source; groups sort by count desc, then label. */
export function groupExceptionsBySource(
  items: ReadonlyArray<ExceptionItem>,
): ExceptionSourceGroup[] {
  const map = new Map<ExceptionSource, ExceptionItem[]>();
  for (const it of items) {
    if (!map.has(it.source)) map.set(it.source, []);
    map.get(it.source)!.push(it);
  }
  return [...map.entries()]
    .map(([source, groupItems]) => ({
      source,
      sourceLabel: SOURCE_LABEL[source] ?? source,
      items: groupItems,
      count: groupItems.length,
    }))
    .sort((a, b) => b.count - a.count || a.sourceLabel.localeCompare(b.sourceLabel));
}

/** Rolled-up counts for the inbox summary header. */
export function getExceptionCounts(items: ReadonlyArray<ExceptionItem>): ExceptionCounts {
  const bySeverity: Record<ExceptionSeverity, number> = { critical: 0, warning: 0, info: 0 };
  const bySource: Partial<Record<ExceptionSource, number>> = {};
  const jobs = new Set<string>();
  let actionable = 0;
  for (const it of items) {
    bySeverity[it.severity] += 1;
    bySource[it.source] = (bySource[it.source] ?? 0) + 1;
    if (it.jobId) jobs.add(it.jobId);
    if (isActionable(it)) actionable += 1;
  }
  return {
    total: items.length,
    bySeverity,
    bySource,
    jobsAffected: jobs.size,
    actionable,
    waiting: items.length - actionable,
  };
}

/** Per-job rollups (for a job-summary strip if needed). */
export interface JobSummary {
  jobId: string;
  jobName: string;
  total: number;
  critical: number;
  actionable: number;
}
export function buildJobSummaries(items: ReadonlyArray<ExceptionItem>): JobSummary[] {
  return groupExceptionsByJob(items)
    .filter((g): g is ExceptionJobGroup & { jobId: string } => g.jobId !== null)
    .map((g) => ({
      jobId: g.jobId,
      jobName: g.jobName,
      total: g.count,
      critical: g.items.filter((i) => i.severity === "critical").length,
      actionable: g.items.filter((i) => isActionable(i)).length,
    }));
}
