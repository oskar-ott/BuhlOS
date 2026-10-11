/**
 * Workshop Stock — saves on this device whose outcome isn't known yet
 * (localStorage, one entry per operation key).
 *
 * Offline is not "saved": a take/add/return is only done when the server says
 * so. Before a write leaves the phone we remember WHAT it was and the operation
 * key it carries; if the response never arrives (no signal, the phone slept or
 * killed the app, the tab reloaded) the next visit asks the server "did
 * operation <key> save?" (GET ?action=operation) and either shows the saved
 * result or offers to retry with the SAME key — never a second movement.
 *
 * Several can be pending at once (a take, then an add before the first
 * answered): each is kept under its own key, so starting a second save never
 * forgets the first. An entry is cleared on a definite answer, after a day, and
 * on Phil sign-out (clearAllPending).
 *
 * It belongs to the person who made it: stamped with the viewer id the list
 * response carries, and only ever read back for that same viewer — on a shared
 * phone the next worker never sees (or re-sends) someone else's save.
 *
 * Browser storage can be missing or throw (private mode, blocked storage), so
 * every access is guarded; without it the feature still works, it just can't
 * reconcile across a reload.
 */

export interface PendingSave {
  key: string;
  kind: "take" | "add" | "return" | "create";
  itemId: string | null;
  itemName: string;
  quantityLabel: string;
  /** What to POST again on retry (same key). */
  request: Record<string, unknown>;
  startedAt: string;
  /** Who made it (stamped from setPendingOwner) — read back only for them. */
  userId?: string | null;
}

const STORAGE_KEY = "buhlos.workshopStock.pendingSaves";
const LEGACY_KEY = "buhlos.workshopStock.pending";
const MAX_PENDING = 10;
const MAX_AGE_MS = 24 * 3600_000;
/**
 * A save the server has no record of is only called "didn't go through" once
 * it is older than this: a request that is still in flight (or queued in a slow
 * network) would otherwise be reported lost while it is about to land.
 */
export const NOT_SAVED_AFTER_MS = 90_000;

let owner: string | null = null;

/** The signed-in viewer, from the list response. Saves remembered before it is known can't be reconciled. */
export function setPendingOwner(viewerId: string | null): void {
  owner = viewerId;
}

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readAll(): Record<string, PendingSave> {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, PendingSave>) : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, PendingSave>): void {
  try {
    const s = storage();
    if (!s) return;
    if (Object.keys(all).length) s.setItem(STORAGE_KEY, JSON.stringify(all));
    else s.removeItem(STORAGE_KEY);
  } catch {
    /* storage full / blocked — reconcile just won't survive a reload */
  }
}

function fresh(p: PendingSave | null | undefined, now: number): p is PendingSave {
  return Boolean(p && typeof p.key === "string" && typeof p.kind === "string" && now - Date.parse(p.startedAt) <= MAX_AGE_MS);
}

export function rememberPending(p: PendingSave): void {
  const now = Date.now();
  const all = readAll();
  for (const [k, v] of Object.entries(all)) if (!fresh(v, now)) delete all[k];
  all[p.key] = { ...p, userId: owner };
  // never grow without bound: the oldest go first
  const keys = Object.keys(all).sort((a, b) => Date.parse(all[a]!.startedAt) - Date.parse(all[b]!.startedAt));
  while (keys.length > MAX_PENDING) delete all[keys.shift()!];
  writeAll(all);
}

/** This viewer's pending saves, oldest first. Someone else's are never returned. */
export function readPending(viewerId: string): PendingSave[] {
  const now = Date.now();
  const all = readAll();
  let changed = false;
  for (const [k, v] of Object.entries(all)) {
    if (!fresh(v, now)) {
      delete all[k];
      changed = true;
    }
  }
  if (changed) writeAll(all);
  return Object.values(all)
    .filter((p) => p.userId && p.userId === viewerId)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

/** One save has a definite answer. */
export function clearPending(key: string): void {
  const all = readAll();
  if (!(key in all)) return;
  delete all[key];
  writeAll(all);
}

/** Sign-out: nothing of this person's is left on the device. */
export function clearAllPending(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
    storage()?.removeItem(LEGACY_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** The server has no record of it: "didn't go through" only once it's old enough to be sure. */
export function definitelyNotSaved(p: Pick<PendingSave, "startedAt">, now = Date.now()): boolean {
  return now - Date.parse(p.startedAt) > NOT_SAVED_AFTER_MS;
}

/**
 * Is this failure an UNCERTAIN outcome (the write may have landed) rather than a
 * definite refusal? Network/timeout (status 0) and 5xx are uncertain; any 4xx is
 * a definite answer — and so is a 503 that names the store as unreachable or
 * unset (the server refused before trying, so nothing was saved).
 */
export function isUncertain(status: number, body?: unknown): boolean {
  const code = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (status === 503 && (code === "store_unavailable" || code === "store_unprovisioned")) return false;
  return status === 0 || status >= 500;
}
