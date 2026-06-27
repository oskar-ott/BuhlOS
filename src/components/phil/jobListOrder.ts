import type { JobListPrefs } from "./jobListPrefs";

/**
 * Phil — pure ordering of the jobs list from a worker's prefs (#145).
 *
 * Constitution: this is an ADDITIVE ORDERING over the SAME list — place-first,
 * name-first navigation stays (P1, AC5). It serves the worker juggling many
 * sites (P14) while staying invisible for the single-job worker (P10): the
 * Recent group only shows once a worker has MORE than ~3 jobs.
 *
 * The order is: pinned first, then recents, then everyone else name-first (as
 * today). A job with no recents/pins simply sorts name-first (P7 — never a
 * fabricated "recent").
 *
 * Pure + deterministic so it is unit-tested in the node env with no DOM.
 */

/** Above this many assigned jobs, surface the automatic "Recent" group. */
export const RECENT_GROUP_MIN_JOBS = 3;

/** How many recents to show in the Recent group (a tired-glance shortlist). */
export const RECENT_GROUP_SIZE = 3;

/** The minimal shape the ordering needs — any Job satisfies this. */
export interface OrderableJob {
  id: string;
  name: string;
}

export interface JobListOrder<T extends OrderableJob> {
  /**
   * The automatic "Recent" shortlist shown ABOVE the full list, or [] when the
   * gate isn't met (≤ RECENT_GROUP_MIN_JOBS jobs) or there are no recents.
   * Excludes pinned jobs (those already sit at the top of the full list).
   */
  recentGroup: T[];
  /** The full list, ordered: pinned first, recents next, rest name-first. */
  fullList: T[];
  /** True when the Recent group should render (gate met AND it's non-empty). */
  showRecentGroup: boolean;
}

function byName<T extends OrderableJob>(a: T, b: T): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/**
 * Order assigned jobs by a worker's prefs.
 *
 * - `fullList`: pinned jobs (in pin order) first, then recently-opened jobs not
 *   already pinned (most-recent-first), then everyone else name-first.
 * - `recentGroup`: the top few recents (not pinned), gated to workers with more
 *   than RECENT_GROUP_MIN_JOBS jobs. Empty otherwise.
 *
 * Ids in prefs that no longer match an assigned job are ignored (stale pin /
 * recent after a re-assignment — never an orphan row).
 */
export function orderJobList<T extends OrderableJob>(
  jobs: ReadonlyArray<T>,
  prefs: JobListPrefs,
): JobListOrder<T> {
  const byId = new Map<string, T>();
  for (const job of jobs) byId.set(job.id, job);

  const pinnedSet = new Set(prefs.pinned.filter((id) => byId.has(id)));
  const pinned: T[] = prefs.pinned
    .map((id) => byId.get(id))
    .filter((j): j is T => j !== undefined);

  // Recents that are still assigned and not already pinned (pins outrank).
  const recents: T[] = prefs.recents
    .filter((id) => byId.has(id) && !pinnedSet.has(id))
    .map((id) => byId.get(id) as T);
  const recentIds = new Set(recents.map((j) => j.id));

  // Everyone else, name-first (as today).
  const rest: T[] = jobs
    .filter((j) => !pinnedSet.has(j.id) && !recentIds.has(j.id))
    .slice()
    .sort(byName);

  const fullList: T[] = [...pinned, ...recents, ...rest];

  // The automatic Recent group: top few recents, gated on a worker who's
  // actually juggling jobs. Zero clutter for ≤3 jobs (P10).
  const gateMet = jobs.length > RECENT_GROUP_MIN_JOBS;
  const recentGroup: T[] = gateMet ? recents.slice(0, RECENT_GROUP_SIZE) : [];

  return {
    recentGroup,
    fullList,
    showRecentGroup: recentGroup.length > 0,
  };
}
