import {
  hoursExceptions,
  jobExceptions,
  materialExceptions,
  observationExceptions,
} from "./mappers";
import { isSafeActionHref, type ExceptionActionState } from "./routes";
import { SOURCE_LABEL } from "./labels";
import type {
  ExceptionFilters,
  ExceptionItem,
  ExceptionSeverity,
  ExceptionSources,
  ExceptionSummary,
} from "./types";

/**
 * The Exceptions Inbox projection: aggregate every source mapper, de-duplicate
 * by id, decorate `sourceLabel`, and sort deterministically. Plus filtering,
 * age labels, and the clickable-action predicate. Pure — no fetching, no
 * Date.now() (age decoration takes an injected `now`).
 */

const SEVERITY_ORDER: Record<ExceptionSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

// Actionable-now (available/fallback) sorts before waiting (unavailable/future).
const ACTION_ORDER: Record<ExceptionActionState, number> = {
  available: 0,
  fallback: 1,
  unavailable: 2,
  future: 3,
};

/** Build the unified, sorted, de-duplicated, source-labelled exception list. */
export function buildExceptions(sources: ExceptionSources): ExceptionItem[] {
  const all = [
    ...hoursExceptions(sources.hoursPending, sources.hoursRejected),
    ...observationExceptions(sources.observations),
    ...jobExceptions(sources.jobs),
    ...materialExceptions(sources.materialRequests),
  ];

  const seen = new Set<string>();
  const deduped: ExceptionItem[] = [];
  for (const item of all) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push({ ...item, sourceLabel: SOURCE_LABEL[item.source] ?? item.source });
  }

  return sortExceptions(deduped);
}

/** Stable sort by the documented comparator (does not mutate the input). */
export function sortExceptions(items: ReadonlyArray<ExceptionItem>): ExceptionItem[] {
  return [...items].sort(compareExceptions);
}

/**
 * Deterministic, explainable order:
 *   1. severity   — critical → warning → info
 *   2. action     — actionable now (available, fallback) before waiting
 *                   (unavailable, future)
 *   3. age        — oldest createdAt first (undated sort after dated)
 *   4. id         — stable tiebreaker, so order never depends on input order
 */
export function compareExceptions(a: ExceptionItem, b: ExceptionItem): number {
  const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (sev !== 0) return sev;
  const act = ACTION_ORDER[a.actionState] - ACTION_ORDER[b.actionState];
  if (act !== 0) return act;
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
  const q = filters.query?.trim().toLowerCase();
  return items.filter((it) => {
    if (filters.source && filters.source !== "all" && it.source !== filters.source) return false;
    if (filters.severity && filters.severity !== "all" && it.severity !== filters.severity) return false;
    if (filters.jobId && filters.jobId !== "all" && it.jobId !== filters.jobId) return false;
    if (filters.availability === "actionable" && !isClickable(it)) return false;
    if (filters.availability === "waiting" && isClickable(it)) return false;
    if (q) {
      const hay = `${it.title} ${it.summary ?? ""} ${it.jobName ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
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

/** True if the action has a usable state AND a safe href (available or fallback). */
function isClickable(item: ExceptionItem): boolean {
  return (
    (item.actionState === "available" || item.actionState === "fallback") &&
    isSafeActionHref(item.actionHref)
  );
}

/**
 * Whether an item's action should render as a clickable link. `available` and
 * `fallback` both carry a safe href (fallback = a real parent surface). Anything
 * else renders as a muted state — never a broken link.
 */
export function isActionable(item: ExceptionItem): boolean {
  return isClickable(item);
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Relative age of an ISO timestamp vs `nowMs`. Pure — caller injects `now`. */
export function deriveAgeLabel(createdAt: string | undefined, nowMs: number): string | undefined {
  if (!createdAt) return undefined;
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return undefined;
  const diff = nowMs - t;
  if (diff < MIN) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  return `${Math.floor(diff / DAY)}d ago`;
}

/** Decorate items with `ageLabel` using a single `now` (does not re-sort). */
export function decorateAges(
  items: ReadonlyArray<ExceptionItem>,
  nowMs: number,
): ExceptionItem[] {
  return items.map((it) => ({ ...it, ageLabel: deriveAgeLabel(it.createdAt, nowMs) }));
}
