import { TimeEntrySchema } from "./schema";
import type { TimeEntry } from "./types";

/**
 * Client-side journal of server-CONFIRMED hours saves (2026-08-06).
 *
 * The store's blob listing and CDN can lag a fresh write by seconds — and
 * since the Phil pages read entries in-process inside the SSR function
 * (2026-08-03), the write-primed cache in the API function no longer covers
 * the very next render: a worker could log a day, open My Day, and be told
 * "Today not logged". The in-memory overlay from 2026-07-28
 * (PhilHoursSharpened.savedEntries + mergeSavedEntries) already fixes this
 * WITHIN one mounted screen; this journal persists the same server-confirmed
 * entries across navigations and reloads until the store catches up.
 *
 * Honesty (P7): every journal record is an entry body the SERVER returned
 * from a successful save — never a guess, never an unconfirmed local draft.
 * Records expire after a short window (the store's staleness is seconds, the
 * window is generous minutes), are scoped to the entry's own userId so a
 * shared phone never shows another worker's day, and always lose to a
 * strictly newer server copy (mergeSavedEntries' existing rule).
 */

const STORAGE_KEY = "buhlos.hours.savedEntries.v1";

/** How long a confirmed save stays mergeable. Store propagation is seconds;
 *  the window is minutes so an app relaunch straight after logging is safe. */
export const SAVED_ENTRY_TTL_MS = 15 * 60 * 1000;

/** Hard cap on journal size — a worker logs one day at a time; anything past
 *  this is stale noise. Oldest records are dropped first. */
const MAX_RECORDS = 20;

interface JournalRecord {
  savedAtMs: number;
  entry: TimeEntry;
}

/** Minimal Storage surface — injectable in node-env tests. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStore(): StorageLike | null {
  // localStorage, not sessionStorage: field workers close and reopen the
  // installed app constantly — the vanish window must survive a relaunch.
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null; // storage disabled (private mode etc.) — journal is a no-op
  }
}

function readRecords(store: StorageLike, nowMs: number): JournalRecord[] {
  let parsed: unknown;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return [];
    parsed = JSON.parse(raw);
  } catch {
    return []; // corrupt journal — treat as empty, never throw into the UI
  }
  if (!Array.isArray(parsed)) return [];
  const records: JournalRecord[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const { savedAtMs, entry } = item as { savedAtMs?: unknown; entry?: unknown };
    if (typeof savedAtMs !== "number") continue;
    if (nowMs - savedAtMs > SAVED_ENTRY_TTL_MS) continue; // expired
    if (savedAtMs > nowMs + 60_000) continue; // clock-skew garbage
    const shaped = TimeEntrySchema.safeParse(entry);
    if (!shaped.success) continue;
    records.push({ savedAtMs, entry: shaped.data });
  }
  return records;
}

/**
 * Record a server-confirmed save. `entry` MUST be the entry body a successful
 * POST/PATCH response returned (the same contract as
 * PhilHoursSharpened.recordSaved). Replaces any previous record for the same
 * user + date. Never throws — a full or disabled storage silently degrades to
 * the existing in-memory behaviour.
 */
export function recordSavedEntry(
  entry: TimeEntry,
  nowMs: number = Date.now(),
  store: StorageLike | null = defaultStore(),
): void {
  if (!store) return;
  try {
    const kept = readRecords(store, nowMs).filter(
      (r) => !(r.entry.userId === entry.userId && r.entry.date === entry.date),
    );
    kept.push({ savedAtMs: nowMs, entry });
    kept.sort((a, b) => a.savedAtMs - b.savedAtMs);
    const trimmed = kept.slice(-MAX_RECORDS);
    store.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Quota/serialisation failure — the save itself already succeeded on the
    // server; losing the journal record only re-exposes the propagation lag.
  }
}

/**
 * The viewer's unexpired server-confirmed saves, oldest first. Only entries
 * whose own userId matches `viewerId` are returned (shared-device safety).
 * Safe to call anywhere — returns [] on the server or when storage is out.
 */
export function readSavedEntries(
  viewerId: string | null | undefined,
  nowMs: number = Date.now(),
  store: StorageLike | null = defaultStore(),
): TimeEntry[] {
  if (!store || !viewerId) return [];
  return readRecords(store, nowMs)
    .filter((r) => r.entry.userId === viewerId)
    .map((r) => r.entry);
}

/** True when the journal holds a confirmed entry for this viewer + date. */
export function hasSavedEntryForDate(
  viewerId: string | null | undefined,
  date: string,
  nowMs: number = Date.now(),
  store: StorageLike | null = defaultStore(),
): boolean {
  return readSavedEntries(viewerId, nowMs, store).some((e) => e.date === date);
}
