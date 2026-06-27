/**
 * Phil — recent + pinned jobs on the jobs list (#145).
 *
 * Constitution: P14 (Phil remembers so the worker doesn't) and P10 (zero clutter
 * for a single-job worker — the Recent group only appears once a worker juggles
 * more than ~3 jobs; see the ordering helper). A worker on many sites re-finds
 * the same 2-3 every day: surface the recently-opened ones automatically and let
 * them pin a favourite, so the next visit is one glance + one tap. This is an
 * ADDITIVE ORDERING over the SAME list — place-first, name-first navigation
 * stays (P1, AC5); a job with no recents/pins just sorts name-first as today (P7,
 * never a fabricated "recent").
 *
 * v1 is CLIENT-ONLY (no server schema; Epic 18 does server prefs later). State
 * is keyed by userId and purged on sign-out so a shared device never leaks the
 * previous worker's list (AC4).
 *
 * Mirrors jobResume.ts: storage is injectable (defaults to window.localStorage)
 * so this is unit-testable in the node env and SSR-safe (no window → no-op).
 * Best-effort by design — private mode / quota / bad JSON never throw into render.
 *
 * NOTE: distinct from jobResume.ts (#425), which is keyed by jobId only and
 * remembers area+stage WITHIN a job. This is keyed by userId and remembers which
 * jobs the worker uses across the list.
 */

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const KEY_PREFIX = "phil-job-list-prefs:";

/** How many recently-opened jobs to remember (most-recent-first). */
export const RECENTS_CAP = 8;

export type JobListPrefs = {
  /** Job ids, most-recent-first, capped at RECENTS_CAP. */
  recents: string[];
  /** Job ids the worker has pinned. Insertion order (oldest-pinned first). */
  pinned: string[];
};

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function keyFor(userId: string): string {
  return KEY_PREFIX + userId;
}

/** Coerce an unknown value into a clean string[] (drops blanks + non-strings, dedupes). */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v !== "string" || !v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Read this worker's list prefs, or an empty value if none/invalid. Always
 * returns a well-formed { recents, pinned } so callers never branch on null.
 */
export function readJobListPrefs(
  userId: string,
  storage: StorageLike | null = defaultStorage(),
): JobListPrefs {
  if (!storage || !userId) return { recents: [], pinned: [] };
  try {
    const raw = storage.getItem(keyFor(userId));
    if (!raw) return { recents: [], pinned: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { recents: [], pinned: [] };
    return {
      recents: toStringArray((parsed as { recents?: unknown }).recents).slice(0, RECENTS_CAP),
      pinned: toStringArray((parsed as { pinned?: unknown }).pinned),
    };
  } catch {
    return { recents: [], pinned: [] };
  }
}

function write(userId: string, prefs: JobListPrefs, storage: StorageLike): void {
  try {
    storage.setItem(
      keyFor(userId),
      JSON.stringify({ recents: prefs.recents, pinned: prefs.pinned }),
    );
  } catch {
    /* private mode / quota — prefs are best-effort, never throws into render */
  }
}

/**
 * Record that the worker just opened this job: move it to the front of recents
 * (most-recent-first), de-duplicating and capping. Returns the new prefs so a
 * caller can update state without a re-read. Silent on any storage failure.
 */
export function recordView(
  userId: string,
  jobId: string,
  storage: StorageLike | null = defaultStorage(),
): JobListPrefs {
  if (!storage || !userId || !jobId) return readJobListPrefs(userId, storage);
  const prev = readJobListPrefs(userId, storage);
  const recents = [jobId, ...prev.recents.filter((id) => id !== jobId)].slice(0, RECENTS_CAP);
  const next: JobListPrefs = { recents, pinned: prev.pinned };
  write(userId, next, storage);
  return next;
}

/**
 * Toggle a job's pinned state. Returns the new prefs so the caller can update
 * state without a re-read. Silent on any storage failure.
 */
export function togglePin(
  userId: string,
  jobId: string,
  storage: StorageLike | null = defaultStorage(),
): JobListPrefs {
  if (!storage || !userId || !jobId) return readJobListPrefs(userId, storage);
  const prev = readJobListPrefs(userId, storage);
  const isPinned = prev.pinned.includes(jobId);
  const pinned = isPinned
    ? prev.pinned.filter((id) => id !== jobId)
    : [...prev.pinned, jobId];
  const next: JobListPrefs = { recents: prev.recents, pinned };
  write(userId, next, storage);
  return next;
}

/**
 * Drop this worker's prefs entirely (shared-device safety). Called on sign-out
 * so the next worker on the same device never inherits the previous worker's
 * recent + pinned jobs (AC4). Silent on any storage failure.
 */
export function purgeJobListPrefs(
  userId: string,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage || !userId) return;
  try {
    storage.removeItem(keyFor(userId));
  } catch {
    /* best-effort — never throws into the sign-out flow */
  }
}
