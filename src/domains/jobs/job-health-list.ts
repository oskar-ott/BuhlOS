import { type JobHealth, type JobHealthLevel } from "./job-health";

/**
 * Pure list-level helpers over per-job health (#227) — rank, parse, sort, count.
 * The jobs list uses these to triage the portfolio "needs me first" without any
 * recomputation of the underlying counts (deriveJobHealth already did that).
 */

/** Display + sort order: trouble first, honest-unknown last. */
export const HEALTH_LEVELS: ReadonlyArray<JobHealthLevel> = ["at-risk", "watch", "good", "unknown"];

const RANK: Record<JobHealthLevel, number> = { "at-risk": 0, watch: 1, good: 2, unknown: 3 };

export function healthRank(level: JobHealthLevel): number {
  return RANK[level];
}

/** Validate a `?health=` URL value; unknown/garbage → null (no filter). */
export function parseHealthParam(v: string | null | undefined): JobHealthLevel | null {
  return v && (HEALTH_LEVELS as readonly string[]).includes(v) ? (v as JobHealthLevel) : null;
}

export interface JobWithHealth<T> {
  job: T;
  health: JobHealth;
}

/** Stable sort by health severity (at-risk → watch → good → unknown). */
export function sortByHealth<T>(items: ReadonlyArray<JobWithHealth<T>>): JobWithHealth<T>[] {
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => healthRank(a.it.health.level) - healthRank(b.it.health.level) || a.i - b.i)
    .map((x) => x.it);
}

/** Count per health level — for the filter pills. */
export function healthCounts<T>(items: ReadonlyArray<JobWithHealth<T>>): Record<JobHealthLevel, number> {
  const c: Record<JobHealthLevel, number> = { "at-risk": 0, watch: 0, good: 0, unknown: 0 };
  for (const it of items) c[it.health.level] += 1;
  return c;
}

/** Short label for a health level (the row badge + filter pill). */
export function healthLabel(level: JobHealthLevel): string {
  switch (level) {
    case "at-risk":
      return "At risk";
    case "watch":
      return "Watch";
    case "good":
      return "On track";
    default:
      return "No data";
  }
}
