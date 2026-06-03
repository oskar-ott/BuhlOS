import { describe, it, expect } from "vitest";
import {
  activeMarkupsForPage,
  markupAnchor,
  markupNormPoints,
  philMarkupsForPage,
  summariseMarkups,
  toNormPoint,
} from "./service";
import type { DrawingMarkup } from "./types";

function mk(over: Partial<DrawingMarkup> & { id: string }): DrawingMarkup {
  return {
    jobId: "job-1",
    planId: "plan-1",
    pageIndex: 0,
    type: "pin",
    x: 0.5,
    y: 0.5,
    visibleToPhil: false,
    archived: false,
    ...over,
  } as DrawingMarkup;
}

const SET: DrawingMarkup[] = [
  mk({ id: "a", pageIndex: 0, visibleToPhil: true }),
  mk({ id: "b", pageIndex: 0, visibleToPhil: false }), // office-only
  mk({ id: "c", pageIndex: 1, visibleToPhil: true }), // other page
  mk({ id: "d", pageIndex: 0, visibleToPhil: true, archived: true }), // archived
  mk({ id: "e", planId: "plan-2", pageIndex: 0, visibleToPhil: true }), // other plan
];

describe("activeMarkupsForPage — page + plan scoping, archived excluded", () => {
  it("returns only non-archived markups for the given plan + page", () => {
    const ids = activeMarkupsForPage(SET, "plan-1", 0).map((m) => m.id);
    expect(ids.sort()).toEqual(["a", "b"]); // c=other page, d=archived, e=other plan
  });

  it("does not mix overlays between pages", () => {
    expect(activeMarkupsForPage(SET, "plan-1", 1).map((m) => m.id)).toEqual(["c"]);
  });

  it("does not mix overlays between plan revisions (different planId)", () => {
    expect(activeMarkupsForPage(SET, "plan-2", 0).map((m) => m.id)).toEqual(["e"]);
  });
});

describe("philMarkupsForPage — field sees visibleToPhil + non-archived only", () => {
  it("hides office-only and archived markups from the field", () => {
    const ids = philMarkupsForPage(SET, "plan-1", 0).map((m) => m.id);
    expect(ids).toEqual(["a"]); // b is office-only, d is archived
  });

  it("respects page separation for the field too", () => {
    expect(philMarkupsForPage(SET, "plan-1", 1).map((m) => m.id)).toEqual(["c"]);
  });
});

describe("summariseMarkups", () => {
  it("counts total / visibleToPhil / officeOnly", () => {
    const counts = summariseMarkups(activeMarkupsForPage(SET, "plan-1", 0));
    expect(counts).toEqual({ total: 2, visibleToPhil: 1, officeOnly: 1 });
  });
});

describe("coordinate conversion + clamping", () => {
  it("toNormPoint clamps each axis into 0..1", () => {
    expect(toNormPoint({ x: 1.5, y: -0.2 })).toEqual({ nx: 1, ny: 0 });
    expect(toNormPoint({ x: 0.25, y: 0.75 })).toEqual({ nx: 0.25, ny: 0.75 });
  });

  it("markupNormPoints returns the anchor for pin/note and the points for line/area", () => {
    expect(markupNormPoints(mk({ id: "p", type: "pin", x: 0.3, y: 0.4 }))).toEqual([{ nx: 0.3, ny: 0.4 }]);
    const line = mk({ id: "l", type: "line", x: undefined, y: undefined, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
    expect(markupNormPoints(line)).toEqual([{ nx: 0, ny: 0 }, { nx: 1, ny: 1 }]);
  });

  it("markupNormPoints returns [] when a pin has no usable anchor", () => {
    expect(markupNormPoints({ type: "pin" })).toEqual([]);
  });

  it("markupAnchor returns the first point for line, centroid for area", () => {
    const line = mk({ id: "l", type: "line", x: undefined, y: undefined, points: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }] });
    expect(markupAnchor(line)).toEqual({ nx: 0.2, ny: 0.2 });
    const area = mk({ id: "ar", type: "area", x: undefined, y: undefined, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }] });
    expect(markupAnchor(area)).toEqual({ nx: 0.5, ny: 1 / 3 });
  });
});
