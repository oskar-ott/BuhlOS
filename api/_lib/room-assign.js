'use strict';

// Epic 5 (#206) — pure device-to-room grouping. No SQL, no IO: room rows,
// effective markers (#205) and assignment overrides in, grouped counts out.
// Assignment is DERIVED, never stored — redrawing a room re-groups
// instantly — and a device outside every room lands in the explicit
// unzoned bucket rather than vanishing (issue AC).

const LIVE_ROOM_STATUSES = ['suggested', 'accepted', 'edited'];
const LIVE_SET = new Set(LIVE_ROOM_STATUSES);

// Effective view of a room row — human rename/redraw win on read.
function effectiveRoom(r) {
  return {
    id: r.id,
    name: r.human_name || r.name,
    bbox: r.human_bbox || r.bbox,
    status: r.status,
    origin: r.origin,
    confidence: r.confidence,
  };
}

function liveRooms(rooms) {
  return rooms.filter((r) => LIVE_SET.has(r.status)).map(effectiveRoom);
}

function containsPoint(bbox, p) {
  return (
    p.x >= bbox.x && p.x <= bbox.x + bbox.w && p.y >= bbox.y && p.y <= bbox.y + bbox.h
  );
}

/**
 * Assign LIVE markers to rooms. A human pin (override) wins — room_id null
 * means explicitly unzoned; a pin to a room that has since been rejected
 * falls back to geometry. Geometry: the marker's centre point inside the
 * room's effective bbox; overlapping rooms → smallest area (the more
 * specific zone); inside none → null (unzoned).
 * Returns a Map of markerKey → roomId | null.
 */
function assignMarkers(markers, rooms, overrides) {
  const live = liveRooms(rooms);
  const liveIds = new Set(live.map((r) => r.id));
  const pinByKey = new Map(overrides.map((o) => [o.marker_key, o.room_id ?? null]));
  const out = new Map();
  for (const m of markers) {
    if (m.status !== 'live') continue;
    if (pinByKey.has(m.key)) {
      const pinned = pinByKey.get(m.key);
      if (pinned === null || liveIds.has(pinned)) {
        out.set(m.key, pinned);
        continue;
      }
    }
    const p = { x: m.bbox.x + m.bbox.w / 2, y: m.bbox.y + m.bbox.h / 2 };
    let best = null;
    for (const r of live) {
      if (!containsPoint(r.bbox, p)) continue;
      if (!best || r.bbox.w * r.bbox.h < best.bbox.w * best.bbox.h) best = r;
    }
    out.set(m.key, best ? best.id : null);
  }
  return out;
}

/**
 * Group live markers per (room × legend entry) for the by-room view.
 * Rooms sort by name; the unzoned bucket (roomId null) always renders LAST
 * and only when occupied. Every marker appears exactly once.
 */
function groupByRoom(markers, rooms, overrides) {
  const assignment = assignMarkers(markers, rooms, overrides);
  const nameOf = new Map(liveRooms(rooms).map((r) => [r.id, r.name]));
  const groups = new Map();
  for (const m of markers) {
    if (m.status !== 'live') continue;
    const roomId = assignment.get(m.key) ?? null;
    const groupKey = roomId || '(unzoned)';
    let g = groups.get(groupKey);
    if (!g) {
      g = {
        roomId,
        roomName: roomId ? nameOf.get(roomId) || null : null,
        entries: new Map(),
        total: 0,
      };
      groups.set(groupKey, g);
    }
    const entryKey = m.legendEntryId || '(unlabelled)';
    let e = g.entries.get(entryKey);
    if (!e) {
      e = { legendEntryId: m.legendEntryId, label: m.label, count: 0 };
      g.entries.set(entryKey, e);
    }
    e.count += 1;
    g.total += 1;
  }
  const rows = [...groups.values()].map((g) => ({
    roomId: g.roomId,
    roomName: g.roomName,
    total: g.total,
    entries: [...g.entries.values()].sort(
      (a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)),
    ),
  }));
  rows.sort((a, b) => {
    if (a.roomId === null) return 1;
    if (b.roomId === null) return -1;
    return (
      String(a.roomName).localeCompare(String(b.roomName)) ||
      String(a.roomId).localeCompare(String(b.roomId))
    );
  });
  return rows;
}

module.exports = {
  LIVE_ROOM_STATUSES,
  effectiveRoom,
  liveRooms,
  assignMarkers,
  groupByRoom,
};
