/**
 * Phil — pure search filter for the jobs list (owner-pulled, 2026-07-30).
 *
 * Case-insensitive token match over the fields a worker actually knows a job
 * by: name, code (IV####), legacy ref, and the site address. Every
 * whitespace-separated token must match somewhere ("birdwood 12" finds
 * "Birdwood Estate · 12 Birdwood Rd"). Preserves the incoming order — the
 * list stays recency-sorted while filtered.
 *
 * Pure + deterministic so it is unit-tested in the node env with no DOM.
 */

export interface SearchableJob {
  id: string;
  name: string;
  code?: string | null;
  ref?: string | null;
  siteAddress?: string | null;
}

export function filterJobList<T extends SearchableJob>(
  jobs: ReadonlyArray<T>,
  query: string,
): T[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...jobs];
  return jobs.filter((job) => {
    const haystack = [job.name, job.code, job.ref, job.siteAddress]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return tokens.every((t) => haystack.includes(t));
  });
}
