import type { StockUnit } from "./schema";

/**
 * Workshop Stock, camera table — what survives a reload. The stock itself is safe on
 * the server whatever happens; this keeps the screen's log, so an accidental refresh
 * or a laptop going to sleep 200 items in doesn't take Undo and the totals with it.
 * Browser storage only: a convenience for this computer, never a record.
 */

const KEY = "buhlos.stock.intake.session";
const ZONE_KEY = "buhlos.stock.intake.zone";
const KEEP_MS = 12 * 60 * 60 * 1000;
const THUMBS_KEPT = 40;

export interface SavedRow {
  id: number;
  at: number;
  status: "logged" | "undone";
  itemId: string | null;
  itemName: string | null;
  unit: StockUnit | null;
  location: string | null;
  amountMilli: number | null;
  fromLabel: boolean;
  recordedMilli: number | null;
  movementId: string | null;
  thumb: string | null;
}

export function saveSession(rows: readonly SavedRow[]): void {
  try {
    const out = rows.map((r, i) => (i < THUMBS_KEPT ? r : { ...r, thumb: null }));
    window.localStorage.setItem(KEY, JSON.stringify({ savedAt: Date.now(), rows: out }));
  } catch {
    // Full or blocked. Try once without pictures, then give up: only a convenience.
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ savedAt: Date.now(), rows: rows.map((r) => ({ ...r, thumb: null })) }));
    } catch {
      /* the stock is saved anyway */
    }
  }
}

export function loadSession(now = Date.now()): SavedRow[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { savedAt?: number; rows?: SavedRow[] };
    if (!parsed.savedAt || now - parsed.savedAt > KEEP_MS || !Array.isArray(parsed.rows)) return [];
    return parsed.rows.filter((r) => typeof r?.id === "number" && (r.status === "logged" || r.status === "undone"));
  } catch {
    return [];
  }
}

export function clearSession(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* only a convenience */
  }
}

export interface SavedZone {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function loadZone(camera: string | null): SavedZone | null {
  try {
    const raw = window.localStorage.getItem(`${ZONE_KEY}.${camera ?? "default"}`);
    if (!raw) return null;
    const z = JSON.parse(raw) as SavedZone;
    return [z.x, z.y, z.w, z.h].every((n) => typeof n === "number" && n >= 0 && n <= 1) ? z : null;
  } catch {
    return null;
  }
}

export function saveZone(camera: string | null, zone: SavedZone | null): void {
  try {
    const key = `${ZONE_KEY}.${camera ?? "default"}`;
    if (zone) window.localStorage.setItem(key, JSON.stringify(zone));
    else window.localStorage.removeItem(key);
  } catch {
    /* only a convenience */
  }
}
