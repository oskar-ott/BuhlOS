/**
 * Workshop Stock — "You often take": the items THIS worker takes most, on this
 * phone (localStorage, per viewer id). A shortcut on the Take screen, never a
 * claim about stock: it only remembers which item ids a confirmed take was for.
 *
 * Kept per viewer so a shared phone never shows one worker another's habits;
 * entries fade after 90 days; cleared on Phil sign-out (clearAllOften). Browser
 * storage can be missing or throw (private mode, blocked storage): every access
 * is guarded and the shortcut simply doesn't appear.
 */

interface Taken {
  n: number;
  at: string;
}

type Store = Record<string, Record<string, Taken>>;

const STORAGE_KEY = "buhlos.workshopStock.oftenTaken";
const MAX_AGE_MS = 90 * 24 * 3600_000;
const MAX_PER_VIEWER = 40;

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readAll(): Store {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function writeAll(all: Store): void {
  try {
    const s = storage();
    if (!s) return;
    if (Object.keys(all).length) s.setItem(STORAGE_KEY, JSON.stringify(all));
    else s.removeItem(STORAGE_KEY);
  } catch {
    /* storage full / blocked — the shortcut just won't remember this one */
  }
}

function fresh(t: Taken | undefined, now: number): t is Taken {
  return Boolean(t && typeof t.n === "number" && typeof t.at === "string" && now - Date.parse(t.at) <= MAX_AGE_MS);
}

/** A take was confirmed: remember the item for this viewer. */
export function rememberTaken(viewerId: string | null | undefined, itemId: string, now = Date.now()): void {
  if (!viewerId || !itemId) return;
  const all = readAll();
  const mine: Record<string, Taken> = {};
  for (const [id, t] of Object.entries(all[viewerId] ?? {})) if (fresh(t, now)) mine[id] = t;
  const cur = mine[itemId];
  mine[itemId] = { n: (cur?.n ?? 0) + 1, at: new Date(now).toISOString() };
  const keep = Object.entries(mine).sort((a, b) => b[1].n - a[1].n || Date.parse(b[1].at) - Date.parse(a[1].at)).slice(0, MAX_PER_VIEWER);
  all[viewerId] = Object.fromEntries(keep);
  writeAll(all);
}

/**
 * The items this viewer takes most, most taken first (then most recent), only
 * ones still on the list and not archived. Empty when nothing is remembered —
 * the screen then shows no shortcut rather than a guess.
 */
export function oftenTaken<T extends { id: string; archivedAt?: string | null }>(viewerId: string | null | undefined, items: readonly T[], limit = 3, now = Date.now()): T[] {
  if (!viewerId) return [];
  const mine = readAll()[viewerId] ?? {};
  const byId = new Map(items.filter((i) => !i.archivedAt).map((i) => [i.id, i]));
  return Object.entries(mine)
    .filter(([id, t]) => fresh(t, now) && byId.has(id))
    .sort((a, b) => b[1].n - a[1].n || Date.parse(b[1].at) - Date.parse(a[1].at))
    .slice(0, limit)
    .map(([id]) => byId.get(id)!);
}

/** Sign-out: nothing of this person's habits is left on the device. */
export function clearAllOften(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}
