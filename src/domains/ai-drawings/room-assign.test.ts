import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * #206 — the pure device-to-room grouping (api/_lib/room-assign.js):
 * effective name/bbox overrides, pin > geometry > unzoned precedence,
 * smallest-area tie-break, and the explicit unzoned bucket.
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CJS module under test
const ra: any = requireFromHere("../../../api/_lib/room-assign.js");

type Row = Record<string, unknown>;

const room = (id: string, over: Row = {}): Row => ({
  id,
  origin: "ai",
  status: "suggested",
  name: "KITCHEN",
  human_name: null,
  bbox: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 },
  human_bbox: null,
  confidence: 0.8,
  ...over,
});

const marker = (key: string, cx: number, cy: number, over: Row = {}): Row => ({
  key,
  status: "live",
  bbox: { x: cx - 0.01, y: cy - 0.01, w: 0.02, h: 0.02 },
  legendEntryId: "le_gpo",
  label: "Double GPO",
  ...over,
});

describe("effectiveRoom / liveRooms (#206)", () => {
  it("human rename and redraw win on read; rejected rooms drop out", () => {
    const rooms = [
      room("r1", { human_name: "KITCHEN/DINING", human_bbox: { x: 0, y: 0, w: 0.5, h: 0.5 } }),
      room("r2", { status: "rejected" }),
    ];
    const live = ra.liveRooms(rooms);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      name: "KITCHEN/DINING",
      bbox: { x: 0, y: 0, w: 0.5, h: 0.5 },
    });
  });
});

describe("assignMarkers (#206)", () => {
  it("centre point-in-bbox assigns; outside all rooms → null (unzoned)", () => {
    const rooms = [room("r1")];
    const markers = [marker("d:in", 0.3, 0.3), marker("d:out", 0.9, 0.9)];
    const a = ra.assignMarkers(markers, rooms, []);
    expect(a.get("d:in")).toBe("r1");
    expect(a.get("d:out")).toBeNull();
  });

  it("overlapping rooms → the smallest area wins (the more specific zone)", () => {
    const rooms = [
      room("big", { bbox: { x: 0, y: 0, w: 0.8, h: 0.8 }, name: "LEVEL 1" }),
      room("small", { bbox: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 }, name: "PANTRY" }),
    ];
    const a = ra.assignMarkers([marker("d:1", 0.3, 0.3)], rooms, []);
    expect(a.get("d:1")).toBe("small");
  });

  it("a human pin wins over geometry, including an explicit unzoned pin", () => {
    const rooms = [room("r1")];
    const markers = [marker("d:1", 0.3, 0.3), marker("d:2", 0.3, 0.35)];
    const overrides = [
      { marker_key: "d:1", room_id: null }, // parked unzoned despite sitting in r1
    ];
    const a = ra.assignMarkers(markers, rooms, overrides);
    expect(a.get("d:1")).toBeNull();
    expect(a.get("d:2")).toBe("r1");
  });

  it("a pin to a room that was later rejected falls back to geometry", () => {
    const rooms = [
      room("r1"),
      room("r2", { status: "rejected", bbox: { x: 0.6, y: 0.6, w: 0.3, h: 0.3 } }),
    ];
    const a = ra.assignMarkers(
      [marker("d:1", 0.3, 0.3)],
      rooms,
      [{ marker_key: "d:1", room_id: "r2" }],
    );
    expect(a.get("d:1")).toBe("r1");
  });

  it("redrawn boxes re-group instantly — assignment follows human_bbox", () => {
    const rooms = [room("r1", { human_bbox: { x: 0.6, y: 0.6, w: 0.3, h: 0.3 } })];
    const a = ra.assignMarkers(
      [marker("d:old-spot", 0.3, 0.3), marker("d:new-spot", 0.7, 0.7)],
      rooms,
      [],
    );
    expect(a.get("d:old-spot")).toBeNull();
    expect(a.get("d:new-spot")).toBe("r1");
  });

  it("deleted markers are not assigned", () => {
    const a = ra.assignMarkers([marker("d:1", 0.3, 0.3, { status: "deleted" })], [room("r1")], []);
    expect(a.has("d:1")).toBe(false);
  });
});

describe("groupByRoom (#206)", () => {
  it("groups per room × entry; unzoned bucket is explicit and LAST", () => {
    const rooms = [
      room("r1", { name: "KITCHEN" }),
      room("r2", { name: "BED 2", bbox: { x: 0.6, y: 0.6, w: 0.3, h: 0.3 } }),
    ];
    const markers = [
      marker("d:1", 0.3, 0.3),
      marker("d:2", 0.32, 0.3),
      marker("d:3", 0.3, 0.32, { legendEntryId: "le_dl", label: "LED downlight" }),
      marker("d:4", 0.7, 0.7),
      marker("d:5", 0.95, 0.95), // outside everything
      marker("d:dead", 0.3, 0.3, { status: "deleted" }),
    ];
    const rows = ra.groupByRoom(markers, rooms, []);
    expect(rows.map((r: Row) => r.roomName)).toEqual(["BED 2", "KITCHEN", null]);
    const kitchen = rows[1];
    expect(kitchen.total).toBe(3);
    expect(kitchen.entries[0]).toMatchObject({ label: "Double GPO", count: 2 });
    expect(kitchen.entries[1]).toMatchObject({ label: "LED downlight", count: 1 });
    const unzoned = rows[2];
    expect(unzoned.roomId).toBeNull();
    expect(unzoned.total).toBe(1); // never silently dropped
  });

  it("no unzoned row when every device sits in a room", () => {
    const rows = ra.groupByRoom([marker("d:1", 0.3, 0.3)], [room("r1")], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].roomId).toBe("r1");
  });
});
