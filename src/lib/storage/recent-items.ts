/**
 * Per-device "recently viewed" ring buffer — issue #215.
 *
 * The ⌘K palette opens to a short list of the pages the operator was just on
 * (a job, an employee), so "back to that job I had open" is one keystroke.
 * This is the storage layer for that list.
 *
 * Contract (mirrors src/lib/storage/remembered-filters.ts — the device-local
 * precedent in this folder):
 *   - DEVICE-LOCAL, never synced. It is a convenience cache of where you've
 *     been on THIS browser, nothing more.
 *   - SSR-safe: storage is never touched during render. The tracker writes
 *     inside a mount effect; the palette reads inside an open-effect — both
 *     client-only. `typeof window` is guarded before any access.
 *   - Corrupt / unavailable storage degrades silently to "no recents" (and a
 *     write resets the key) — nothing here ever throws.
 *   - The buffer is a fixed cap (newest first); a repeat visit to the same
 *     path bumps that entry to the top rather than duplicating it.
 *
 * What it deliberately is NOT: recent *command* use (legacy had that); this is
 * recent *pages viewed*. And it is not a history API — just the last few
 * record pages, for the palette's empty state.
 */

/** One visited record. `at` is epoch-ms; used only to order + is not shown. */
export interface RecentItem {
  /** App route to navigate back to (e.g. /v2/jobs/abc, /employees/u1). */
  path: string;
  /** Human label for the row (job name, worker name). */
  title: string;
  /** Record kind — drives the row's group label / icon in the palette. */
  type: "job" | "employee";
  /** When it was last visited (epoch ms). */
  at: number;
}

/** Newest first, deduped by path. Eight is enough for an at-a-glance list. */
export const RECENTS_CAP = 8;
export const RECENTS_KEY = "buhlos.recents.v1";

/** Minimal slice of the Web Storage API the helpers need (test-injectable). */
export interface RecentsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): RecentsStorage | null {
  // `typeof window` guard first: this module is imported by client components
  // that also render on the server, where `window` does not exist at all.
  if (typeof window === "undefined") return null;
  try {
    // Accessing window.localStorage itself can throw (blocked storage).
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Type guard for a single stored entry — defends against older/garbled shapes. */
function isRecentItem(value: unknown): value is RecentItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.path === "string" &&
    v.path.length > 0 &&
    typeof v.title === "string" &&
    (v.type === "job" || v.type === "employee") &&
    typeof v.at === "number" &&
    Number.isFinite(v.at)
  );
}

/**
 * Pure validation of a parsed payload into a clean, capped, newest-first list.
 * Non-arrays, non-entries, and anything past the cap are dropped without error.
 * Exported so the read path and tests share one definition of "valid".
 */
export function sanitizeRecents(raw: unknown): RecentItem[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecentItem(entry)) continue;
    if (seen.has(entry.path)) continue; // tolerate a duplicated path on read
    seen.add(entry.path);
    out.push({ path: entry.path, title: entry.title, type: entry.type, at: entry.at });
    if (out.length >= RECENTS_CAP) break;
  }
  return out;
}

/**
 * Pure ring-buffer push: prepend `item`, drop any existing entry with the same
 * path (de-dupe → bump to top), cap at RECENTS_CAP. Returns a NEW array; the
 * input is never mutated. This is the whole mechanics — storage just persists
 * the result.
 */
export function pushRecent(existing: ReadonlyArray<RecentItem>, item: RecentItem): RecentItem[] {
  const deduped = existing.filter((e) => e.path !== item.path);
  return [item, ...deduped].slice(0, RECENTS_CAP);
}

/** Read + validate the list. [] when absent, invalid, or storage unavailable. */
export function readRecentItems(storage: RecentsStorage | null = defaultStorage()): RecentItem[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(RECENTS_KEY);
    if (!raw) return [];
    return sanitizeRecents(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * Record a visited record (de-dupe/bump/cap), persisting the result. Call from
 * a mount effect only — never during render. A blank path/title is ignored
 * (nothing useful to navigate back to). Best-effort: storage errors (quota,
 * private mode) are swallowed, the palette just shows fewer/no recents.
 */
export function recordRecentItem(
  item: { path: string; title: string; type: RecentItem["type"]; at?: number },
  storage: RecentsStorage | null = defaultStorage()
): void {
  if (!storage) return;
  const path = item.path?.trim();
  const title = item.title?.trim();
  if (!path || !title) return;
  try {
    const current = readRecentItems(storage);
    const next = pushRecent(current, {
      path,
      title,
      type: item.type,
      at: typeof item.at === "number" ? item.at : Date.now(),
    });
    storage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Quota / private mode / corrupt prior value — try to reset so a future
    // write can succeed; if even that throws, give up silently.
    try {
      storage.removeItem(RECENTS_KEY);
    } catch {
      /* nothing more to do */
    }
  }
}
