/**
 * Workshop Stock — the one pending save on this device (localStorage).
 *
 * Offline is not "saved": a take/add/return is only done when the server says
 * so. Before a write leaves the phone we remember WHAT it was and the operation
 * key it carries; if the response never arrives (no signal, the phone slept or
 * killed the app, the tab reloaded) the next visit asks the server "did
 * operation <key> save?" (GET ?action=operation) and either shows the saved
 * result or offers to retry with the SAME key — never a second movement.
 * Cleared on a definite answer, after a day, and on Phil sign-out.
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

const STORAGE_KEY = "buhlos.workshopStock.pending";
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

export function rememberPending(p: PendingSave): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ ...p, userId: owner }));
  } catch {
    /* storage full / blocked — reconcile just won't survive a reload */
  }
}

export function readPending(viewerId: string): PendingSave | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingSave;
    if (!p || typeof p.key !== "string" || typeof p.kind !== "string") return null;
    if (!p.userId || p.userId !== viewerId) return null; // someone else's — never shown or re-sent
    // A day-old pending save is stale; the server keeps the answer, but the worker has moved on.
    if (Date.now() - Date.parse(p.startedAt) > 24 * 3600_000) {
      clearPending();
      return null;
    }
    return p;
  } catch {
    return null;
  }
}

export function clearPending(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Is this failure an UNCERTAIN outcome (the write may have landed) rather than a
 * definite refusal? Network/timeout (status 0) and 5xx are uncertain; any 4xx is
 * a definite answer from the server.
 */
export function isUncertain(status: number): boolean {
  return status === 0 || status >= 500;
}
