import { describe, it, expect } from "vitest";
import {
  acceptedAreaRefsFrom,
  bboxIou,
  diffRoomsVsAcceptedAreas,
  type AcceptedAreaRef,
  type DetectedRoomRef,
} from "./room-rev-diff";

const room = (over: Partial<DetectedRoomRef> & { roomId: string; name: string }): DetectedRoomRef => ({
  planId: "pl2",
  bbox: { x: 0.3, y: 0.4, w: 0.2, h: 0.15 },
  status: "suggested",
  ...over,
});

const area = (over: Partial<AcceptedAreaRef> & { areaId: string; name: string }): AcceptedAreaRef => ({
  aiSourceId: `aidr:room:${over.areaId}`,
  planId: "pl1",
  bbox: { x: 0.3, y: 0.4, w: 0.2, h: 0.15 },
  ...over,
});

describe("bboxIou", () => {
  it("is 1 for identical boxes, 0 for disjoint or missing", () => {
    const b = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    expect(bboxIou(b, b)).toBeCloseTo(1);
    expect(bboxIou(b, { x: 0.8, y: 0.8, w: 0.1, h: 0.1 })).toBe(0);
    expect(bboxIou(b, null)).toBe(0);
  });
});

describe("diffRoomsVsAcceptedAreas", () => {
  it("flags a detected room with no accepted area as added", () => {
    const d = diffRoomsVsAcceptedAreas({
      rooms: [room({ roomId: "n1", name: "GARAGE" })],
      accepted: [],
    });
    expect(d.added.map((r) => r.name)).toEqual(["GARAGE"]);
    expect(d.removed).toHaveLength(0);
    expect(d.matched).toBe(0);
  });

  it("flags an accepted area whose room is gone as removed (never auto-deletes)", () => {
    const d = diffRoomsVsAcceptedAreas({
      rooms: [],
      accepted: [area({ areaId: "a1", name: "KITCHEN", aiSourceId: "aidr:room:r1" })],
    });
    expect(d.removed.map((a) => a.name)).toEqual(["KITCHEN"]);
    expect(d.added).toHaveLength(0);
  });

  it("matches by provenance (aiSourceId → roomId) so a re-detected room isn't a change", () => {
    const d = diffRoomsVsAcceptedAreas({
      rooms: [room({ roomId: "r1", name: "KITCHEN" })],
      accepted: [area({ areaId: "a1", name: "KITCHEN", aiSourceId: "aidr:room:r1" })],
    });
    expect(d.matched).toBe(1);
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
  });

  it("matches by label across a new rev (fresh room id, same name)", () => {
    const d = diffRoomsVsAcceptedAreas({
      // new rev → different room id, but the label is unchanged
      rooms: [room({ roomId: "revB-77", name: "bed 2" })],
      accepted: [area({ areaId: "a1", name: "BED 2", aiSourceId: "aidr:room:oldR" })],
    });
    expect(d.matched).toBe(1);
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
  });

  it("pairs an overlapping area+room with different labels as a rename (not add+remove)", () => {
    const d = diffRoomsVsAcceptedAreas({
      rooms: [room({ roomId: "n9", name: "STUDY", planId: "pl1", bbox: { x: 0.31, y: 0.41, w: 0.2, h: 0.15 } })],
      accepted: [area({ areaId: "a1", name: "BED 3", planId: "pl1", bbox: { x: 0.3, y: 0.4, w: 0.2, h: 0.15 } })],
    });
    expect(d.renamed).toHaveLength(1);
    expect(d.renamed[0]!.area.name).toBe("BED 3");
    expect(d.renamed[0]!.room.name).toBe("STUDY");
    // pulled out of both add + remove
    expect(d.added).toHaveLength(0);
    expect(d.removed).toHaveLength(0);
  });

  it("does not treat far-apart boxes as a rename", () => {
    const d = diffRoomsVsAcceptedAreas({
      rooms: [room({ roomId: "n9", name: "STUDY", planId: "pl1", bbox: { x: 0.8, y: 0.8, w: 0.1, h: 0.1 } })],
      accepted: [area({ areaId: "a1", name: "BED 3", planId: "pl1", bbox: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } })],
    });
    expect(d.renamed).toHaveLength(0);
    expect(d.added.map((r) => r.name)).toEqual(["STUDY"]);
    expect(d.removed.map((a) => a.name)).toEqual(["BED 3"]);
  });

  it("ignores rejected rooms entirely", () => {
    const d = diffRoomsVsAcceptedAreas({
      rooms: [room({ roomId: "x", name: "PLANT", status: "rejected" })],
      accepted: [],
    });
    expect(d.added).toHaveLength(0);
  });
});

describe("acceptedAreaRefsFrom", () => {
  it("keeps only live, plan-sourced areas and pulls planId/bbox from provenance", () => {
    const refs = acceptedAreaRefsFrom([
      {
        name: "Level 1",
        areas: [
          {
            id: "ar1",
            name: "KITCHEN",
            aiSourceId: "aidr:room:r1",
            provenance: { planId: "pl1", bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
          },
          { id: "ar2", name: "Hand-made" }, // no aiSourceId → not plan-sourced
          { id: "ar3", name: "Old", aiSourceId: "aidr:room:r3", archived: true }, // archived area
        ],
      },
      // whole group archived → skipped
      { name: "Old wing", archived: true, areas: [{ id: "ar4", name: "X", aiSourceId: "aidr:room:r4" }] },
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ areaId: "ar1", name: "KITCHEN", aiSourceId: "aidr:room:r1", planId: "pl1" });
    expect(refs[0]!.bbox).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
  });
});
