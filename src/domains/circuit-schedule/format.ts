import type { Circuit, Switchboard } from "./types";

/**
 * Circuit schedule — display labels, tones and pure grouping helpers.
 *
 * Kept free of React so the projection logic (sort, group-by-board) is unit
 * testable in isolation (schedule.test.ts). The label maps tolerate unknown
 * values: an unmapped string falls back to a Title-cased version of itself
 * rather than rendering blank, so a server-added enum value still reads.
 */

const DEVICE_LABELS: Record<string, string> = {
  mcb: "MCB",
  rcbo: "RCBO",
  rcd: "RCD",
  "rcd-mcb": "RCD + MCB",
  mccb: "MCCB",
  fuse: "Fuse",
  isolator: "Isolator",
  other: "Other",
};

const TYPE_LABELS: Record<string, string> = {
  power: "Power",
  light: "Lighting",
  emergency: "Emergency",
  data: "Data",
  fire: "Fire",
  mech: "Mech",
  other: "Other",
};

const STATUS_LABELS: Record<string, string> = {
  planned: "Planned",
  "roughed-in": "Roughed in",
  energised: "Energised",
  commissioned: "Commissioned",
};

/** Pill tones (a subset of the src/components/ui/Pill tone union). */
type PillTone = "neutral" | "yellow" | "navy" | "success" | "danger" | "info" | "warning";
const STATUS_TONES: Record<string, PillTone> = {
  planned: "neutral",
  "roughed-in": "warning",
  energised: "info",
  commissioned: "success",
};

function titleCase(v: string): string {
  return v
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function deviceLabel(v: string | undefined): string {
  if (!v) return "";
  return DEVICE_LABELS[v] ?? titleCase(v);
}

export function circuitTypeLabel(v: string | undefined): string {
  if (!v) return "";
  return TYPE_LABELS[v] ?? titleCase(v);
}

export function statusLabel(v: string | undefined): string {
  if (!v) return "";
  return STATUS_LABELS[v] ?? titleCase(v);
}

export function statusTone(v: string | undefined): PillTone {
  return (v && STATUS_TONES[v]) || "neutral";
}

/**
 * Stable sort by `order` ascending, falling back to original index so rows
 * without an explicit order keep their insertion order. Mirrors the
 * `visibleStructural` ordering used across the job structure helpers.
 */
export function sortByOrder<T extends { order?: number }>(rows: ReadonlyArray<T>): T[] {
  return rows
    .map((x, i) => ({ x, i, o: typeof x.order === "number" ? x.order : Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.o - b.o || a.i - b.i)
    .map((t) => t.x);
}

export interface BoardGroup {
  board: Switchboard;
  circuits: Circuit[];
}

/**
 * Group live circuits under their board, both ordered. A circuit whose
 * `switchboardId` matches no live board is dropped (the board was removed) —
 * the schedule only shows circuits that belong to a board on it.
 */
export function groupCircuitsByBoard(
  switchboards: ReadonlyArray<Switchboard>,
  circuits: ReadonlyArray<Circuit>,
  opts: { includeArchived?: boolean } = {}
): BoardGroup[] {
  const includeArchived = opts.includeArchived ?? false;
  const liveBoards = sortByOrder(
    switchboards.filter((b) => includeArchived || !b.archived)
  );
  const liveCircuits = sortByOrder(
    circuits.filter((c) => includeArchived || !c.archived)
  );
  return liveBoards.map((board) => ({
    board,
    circuits: liveCircuits.filter((c) => c.switchboardId === board.id),
  }));
}

/** Total live circuit count — the chip on the section nav row. */
export function liveCircuitCount(circuits: ReadonlyArray<Circuit>): number {
  return circuits.filter((c) => !c.archived).length;
}

/** A human board title: code, with the name appended when distinct. */
export function boardTitle(board: Pick<Switchboard, "code" | "name">): string {
  const code = board.code?.trim() || "Board";
  const name = board.name?.trim();
  return name && name !== code ? `${code} — ${name}` : code;
}
