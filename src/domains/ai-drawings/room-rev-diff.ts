// #206 / re-analysis — the semantic room diff that sits ON TOP of the shipped
// pixel diff (diffPages). Given the rooms detected on a job's plans NOW and the
// areas already ACCEPTED from an earlier analysis (each carrying provenance back
// to its source room), it works out what changed:
//
//   added   — a detected room with no matching accepted area (a new area to make)
//   removed — an accepted area with no matching current room (its room is gone —
//             a plan rev may have deleted or renamed it)
//   renamed — an accepted area + a current room that overlap on the sheet but
//             carry different labels (a likely rename)
//
// It NEVER mutates anything — the caller surfaces the changes for per-change
// accept/dismiss, and "never silently overwrite accepted areas" is guaranteed by
// construction (this only reports). Pure + tested.

import type { CropRegion } from "./schema";

const AI_SOURCE_PREFIX = "aidr:room:";
/** Boxes that overlap at least this much (IoU) are treated as the same place. */
const RENAME_IOU = 0.3;

export interface AcceptedAreaRef {
  areaId: string;
  name: string;
  /** `aidr:room:<roomId>` — the provenance idempotency key. */
  aiSourceId: string;
  planId: string | null;
  /** Approximate region from provenance (normalised 0..1), or null. */
  bbox: CropRegion | null;
}

export interface DetectedRoomRef {
  roomId: string;
  planId: string;
  name: string;
  bbox: CropRegion | null;
  status: "suggested" | "accepted" | "edited" | "rejected";
}

export interface RoomRevDiff {
  added: DetectedRoomRef[];
  removed: AcceptedAreaRef[];
  renamed: Array<{ area: AcceptedAreaRef; room: DetectedRoomRef }>;
  /** Detected rooms already represented by an accepted area (unchanged). */
  matched: number;
}

function norm(name: string): string {
  return name.trim().replace(/\s+/g, " ").toUpperCase();
}

function roomIdFromSource(aiSourceId: string): string | null {
  return aiSourceId.startsWith(AI_SOURCE_PREFIX)
    ? aiSourceId.slice(AI_SOURCE_PREFIX.length)
    : null;
}

/** Intersection-over-union of two normalised boxes; 0 when either is missing. */
export function bboxIou(a: CropRegion | null, b: CropRegion | null): number {
  if (!a || !b) return 0;
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

export function diffRoomsVsAcceptedAreas(input: {
  rooms: DetectedRoomRef[];
  accepted: AcceptedAreaRef[];
}): RoomRevDiff {
  // Live, named rooms only — a rejected or blank room is never a candidate.
  const rooms = input.rooms.filter((r) => r.status !== "rejected" && r.name.trim());
  const accepted = input.accepted.filter((a) => a.name.trim());

  const matchedRoomIds = new Set<string>();
  const matchedAreaIds = new Set<string>();
  let matched = 0;

  // Pass 1 — exact provenance: an area whose source room is present now.
  const roomById = new Map(rooms.map((r) => [r.roomId, r]));
  for (const area of accepted) {
    const srcRoomId = roomIdFromSource(area.aiSourceId);
    if (srcRoomId && roomById.has(srcRoomId) && !matchedRoomIds.has(srcRoomId)) {
      matchedRoomIds.add(srcRoomId);
      matchedAreaIds.add(area.areaId);
      matched += 1;
    }
  }

  // Pass 2 — same label: an unmatched area whose name a current room still uses
  // (the room was re-detected on a new rev with a fresh id).
  const roomsByName = new Map<string, DetectedRoomRef[]>();
  for (const r of rooms) {
    const key = norm(r.name);
    const arr = roomsByName.get(key);
    if (arr) arr.push(r);
    else roomsByName.set(key, [r]);
  }
  for (const area of accepted) {
    if (matchedAreaIds.has(area.areaId)) continue;
    const candidates = roomsByName.get(norm(area.name)) ?? [];
    const room = candidates.find((r) => !matchedRoomIds.has(r.roomId));
    if (room) {
      matchedRoomIds.add(room.roomId);
      matchedAreaIds.add(area.areaId);
      matched += 1;
    }
  }

  let added = rooms.filter((r) => !matchedRoomIds.has(r.roomId));
  let removed = accepted.filter((a) => !matchedAreaIds.has(a.areaId));

  // Pass 3 — rename: an unmatched area + unmatched room that overlap on the
  // sheet but read differently. Pairs are pulled out of added/removed.
  const renamed: Array<{ area: AcceptedAreaRef; room: DetectedRoomRef }> = [];
  const takenRooms = new Set<string>();
  for (const area of removed) {
    let best: { room: DetectedRoomRef; iou: number } | null = null;
    for (const room of added) {
      if (takenRooms.has(room.roomId)) continue;
      if (area.planId && room.planId !== area.planId) continue;
      if (norm(room.name) === norm(area.name)) continue; // same name isn't a rename
      const iou = bboxIou(area.bbox, room.bbox);
      if (iou >= RENAME_IOU && (!best || iou > best.iou)) best = { room, iou };
    }
    if (best) {
      renamed.push({ area, room: best.room });
      takenRooms.add(best.room.roomId);
    }
  }
  const renamedAreaIds = new Set(renamed.map((p) => p.area.areaId));
  added = added.filter((r) => !takenRooms.has(r.roomId));
  removed = removed.filter((a) => !renamedAreaIds.has(a.areaId));

  return { added, removed, renamed, matched };
}

/**
 * Project a job's area groups to the AcceptedAreaRef set the diff needs: live
 * areas that carry plan provenance (aiSourceId), with their source plan + region
 * pulled from provenance. Areas authored by hand (no aiSourceId) are ignored —
 * only plan-sourced areas are diffed against the plan.
 */
export function acceptedAreaRefsFrom(
  areaGroups: ReadonlyArray<{
    name?: string;
    archived?: boolean;
    areas?: ReadonlyArray<{
      id: string;
      name: string;
      archived?: boolean;
      aiSourceId?: string | null;
      provenance?: Record<string, unknown> | null;
    }>;
  }>,
): AcceptedAreaRef[] {
  const out: AcceptedAreaRef[] = [];
  for (const g of areaGroups) {
    if (g.archived) continue;
    for (const a of g.areas ?? []) {
      if (a.archived || typeof a.aiSourceId !== "string" || !a.aiSourceId) continue;
      const prov = a.provenance ?? null;
      const bbox =
        prov && typeof prov.bbox === "object" && prov.bbox !== null
          ? (prov.bbox as CropRegion)
          : null;
      out.push({
        areaId: a.id,
        name: a.name,
        aiSourceId: a.aiSourceId,
        planId: prov && typeof prov.planId === "string" ? prov.planId : null,
        bbox,
      });
    }
  }
  return out;
}
