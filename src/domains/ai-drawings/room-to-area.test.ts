import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";

// #206 rooms→areas bridge — the pure merge, tested without PG/blob. Mirrors the
// room-assign / count-review test seam (createRequire into api/_lib).
const requireFromHere = createRequire(import.meta.url);
const { buildRoomAreaMerge, aiSourceIdForRoom } = requireFromHere(
  "../../../api/_lib/room-to-area.js",
) as {
  buildRoomAreaMerge: (input: {
    rooms: Array<Record<string, unknown>>;
    plans: Array<Record<string, unknown>>;
    existingGroups: Array<Record<string, unknown>>;
  }) => {
    groups: Array<{ id?: string; name: string; archived?: boolean; areas: Array<Record<string, unknown>> }>;
    created: Array<{ roomId: string; areaName: string; groupName: string; aiSourceId: string }>;
    skipped: Array<{ roomId: string; reason: string }>;
    sheets: Array<{ planId: string; planLabel: string; revision: string | null; level: string | null; created: number; considered: number }>;
  };
  aiSourceIdForRoom: (id: string) => string;
};

const room = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  planId: "p1",
  pageIndex: 0,
  effectiveName: "KITCHEN",
  effectiveBbox: { x: 0.3, y: 0.4, w: 0.2, h: 0.15 },
  confidence: 0.9,
  status: "accepted",
  ...over,
});

describe("buildRoomAreaMerge", () => {
  it("groups reviewed rooms by the plan's level and names areas verbatim", () => {
    const out = buildRoomAreaMerge({
      rooms: [
        room({ id: "r1", effectiveName: "KITCHEN", status: "accepted" }),
        room({ id: "r2", effectiveName: "BED 2", status: "edited" }),
      ],
      plans: [{ id: "p1", label: "E-101", level: "Level 1", revision: "B" }],
      existingGroups: [],
    });
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]!.name).toBe("Level 1");
    expect(out.groups[0]!.areas.map((a) => a.name)).toEqual(["KITCHEN", "BED 2"]);
    // provenance + idempotency key present, no id (validateAreaGroups mints it).
    const a0 = out.groups[0]!.areas[0]!;
    expect(a0.aiSourceId).toBe(aiSourceIdForRoom("r1"));
    expect(a0.id).toBeUndefined();
    expect(a0.provenance).toMatchObject({
      source: "ai-drawings-room",
      roomId: "r1",
      planId: "p1",
      pageIndex: 0,
      rev: "B",
    });
    expect(out.created).toHaveLength(2);
    expect(out.skipped).toHaveLength(0);
  });

  it("only accepts reviewed rooms — suggested and rejected are skipped (human-accept gate)", () => {
    const out = buildRoomAreaMerge({
      rooms: [
        room({ id: "r1", status: "suggested" }),
        room({ id: "r2", status: "rejected" }),
      ],
      plans: [{ id: "p1", level: "Level 1" }],
      existingGroups: [],
    });
    expect(out.created).toHaveLength(0);
    expect(out.groups).toHaveLength(0);
    expect(out.skipped).toEqual([
      { roomId: "r1", reason: "not-reviewed" },
      { roomId: "r2", reason: "not-reviewed" },
    ]);
  });

  it("is idempotent — a room whose aiSourceId is already on ANY area is skipped", () => {
    const existingGroups = [
      { id: "ag1", name: "Level 1", areas: [{ id: "ar1", name: "KITCHEN", aiSourceId: aiSourceIdForRoom("r1") }] },
    ];
    const out = buildRoomAreaMerge({
      rooms: [room({ id: "r1", status: "accepted" })],
      plans: [{ id: "p1", level: "Level 1" }],
      existingGroups,
    });
    expect(out.created).toHaveLength(0);
    expect(out.skipped).toEqual([{ roomId: "r1", reason: "already-created" }]);
  });

  it("dedupes against an ARCHIVED area too — re-accepting a dismissed room never duplicates", () => {
    const out = buildRoomAreaMerge({
      rooms: [room({ id: "r1", status: "accepted" })],
      plans: [{ id: "p1", level: "Level 1" }],
      existingGroups: [
        { id: "ag1", name: "Level 1", areas: [{ id: "ar1", name: "KITCHEN", aiSourceId: aiSourceIdForRoom("r1"), archived: true }] },
      ],
    });
    expect(out.created).toHaveLength(0);
    expect(out.skipped[0]!.reason).toBe("already-created");
  });

  it("merges into an existing live group of the same name rather than spawning a parallel one", () => {
    const out = buildRoomAreaMerge({
      rooms: [room({ id: "r1", effectiveName: "KITCHEN" })],
      plans: [{ id: "p1", level: "Level 1" }],
      existingGroups: [{ id: "ag1", name: "Level 1", areas: [{ id: "ar1", name: "HALL" }] }],
    });
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]!.id).toBe("ag1");
    expect(out.groups[0]!.areas.map((a) => a.name)).toEqual(["HALL", "KITCHEN"]);
  });

  it("skips rooms with an empty effective name (no invented labels — P7)", () => {
    const out = buildRoomAreaMerge({
      rooms: [room({ id: "r1", effectiveName: "   " })],
      plans: [{ id: "p1", level: "Level 1" }],
      existingGroups: [],
    });
    expect(out.created).toHaveLength(0);
    expect(out.skipped).toEqual([{ roomId: "r1", reason: "empty-name" }]);
  });

  it("names the group from the sheet label, then a stable fallback, when no level", () => {
    const out = buildRoomAreaMerge({
      rooms: [
        room({ id: "r1", planId: "p1", effectiveName: "KITCHEN" }),
        room({ id: "r2", planId: "p9", effectiveName: "GARAGE" }),
      ],
      plans: [{ id: "p1", label: "E-101" }], // p9 absent from the register
      existingGroups: [],
    });
    const names = out.groups.map((g) => g.name).sort();
    expect(names).toEqual(["E-101", "Plan p9"]);
  });

  it("keeps two rooms that share a printed name as two distinct areas", () => {
    const out = buildRoomAreaMerge({
      rooms: [
        room({ id: "r1", effectiveName: "WIR" }),
        room({ id: "r2", effectiveName: "WIR" }),
      ],
      plans: [{ id: "p1", level: "Level 1" }],
      existingGroups: [],
    });
    expect(out.groups[0]!.areas).toHaveLength(2);
    expect(out.created).toHaveLength(2);
  });

  it("does not mutate the caller's existingGroups", () => {
    const existingGroups = [{ id: "ag1", name: "Level 1", areas: [{ id: "ar1", name: "HALL" }] }];
    buildRoomAreaMerge({
      rooms: [room({ id: "r1", effectiveName: "KITCHEN" })],
      plans: [{ id: "p1", level: "Level 1" }],
      existingGroups,
    });
    expect(existingGroups[0]!.areas).toHaveLength(1);
    expect(existingGroups[0]!.areas[0]!.name).toBe("HALL");
  });

  it("reports an honest per-sheet summary (considered vs created)", () => {
    const out = buildRoomAreaMerge({
      rooms: [
        room({ id: "r1", planId: "p1", status: "accepted" }),
        room({ id: "r2", planId: "p1", status: "suggested" }),
      ],
      plans: [{ id: "p1", label: "E-101", level: "Level 1", revision: "C" }],
      existingGroups: [],
    });
    expect(out.sheets).toEqual([
      { planId: "p1", planLabel: "E-101", revision: "C", level: "Level 1", created: 1, considered: 2 },
    ]);
  });
});
