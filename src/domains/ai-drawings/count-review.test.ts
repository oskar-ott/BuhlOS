import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * #205 — the pure count-review derivation (api/_lib/count-review.js):
 * raw detections (immutable) → append-only review actions → effective
 * markers → counts → staleness. The whole verify loop hangs off this
 * replay, so the ordering and precedence rules are pinned here.
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CJS module under test
const cr: any = requireFromHere("../../../api/_lib/count-review.js");

type Row = Record<string, unknown>;

const det = (id: string, over: Row = {}): Row => ({
  id,
  kind: "device",
  legend_entry_id: "le_gpo",
  label: "Double GPO",
  bbox: { x: 0.4, y: 0.4, w: 0.04, h: 0.04 },
  confidence: 0.9,
  ...over,
});

const rev = (id: string, at: string, over: Row = {}): Row => ({
  id,
  action: "delete",
  target_detection_id: null,
  target_review_id: null,
  legend_entry_id: null,
  label: null,
  bbox: null,
  created_at: at,
  ...over,
});

describe("deriveMarkers (#205)", () => {
  it("with no reviews, AI detections pass through live; uncertain regions ride separately", () => {
    const { markers, uncertain } = cr.deriveMarkers(
      [det("d1"), det("d2"), det("u1", { kind: "uncertain-region", legend_entry_id: null, label: null })],
      [],
    );
    expect(markers).toHaveLength(2);
    expect(markers.every((m: Row) => m.status === "live" && m.source === "ai")).toBe(true);
    expect(uncertain).toHaveLength(1);
  });

  it("delete kills, restore revives, in created_at order", () => {
    const { markers } = cr.deriveMarkers(
      [det("d1")],
      [
        rev("r1", "2026-07-03T01:00:00Z", { target_detection_id: "d1" }),
        rev("r2", "2026-07-03T02:00:00Z", { action: "restore", target_detection_id: "d1" }),
      ],
    );
    expect(markers[0]?.status).toBe("live");
    expect(markers[0]?.appliedReviewIds).toEqual(["r1", "r2"]);
  });

  it("out-of-order input still replays by timestamp — final state is the LATEST action", () => {
    const { markers } = cr.deriveMarkers(
      [det("d1")],
      [
        rev("r2", "2026-07-03T02:00:00Z", { target_detection_id: "d1" }), // later delete
        rev("r1", "2026-07-03T01:00:00Z", { action: "restore", target_detection_id: "d1" }),
      ],
    );
    expect(markers[0]?.status).toBe("deleted");
  });

  it("reclassify moves the marker to the new entry AND revives it (asserting a type asserts existence)", () => {
    const { markers } = cr.deriveMarkers(
      [det("d1")],
      [
        rev("r1", "2026-07-03T01:00:00Z", { target_detection_id: "d1" }),
        rev("r2", "2026-07-03T02:00:00Z", {
          action: "reclassify",
          target_detection_id: "d1",
          legend_entry_id: "le_dl",
          label: "LED downlight",
        }),
      ],
    );
    expect(markers[0]?.status).toBe("live");
    expect(markers[0]?.legendEntryId).toBe("le_dl");
    expect(markers[0]?.label).toBe("LED downlight");
  });

  it("an add creates a human marker; deleting the add kills it", () => {
    const add = rev("ra", "2026-07-03T01:00:00Z", {
      action: "add",
      legend_entry_id: "le_gpo",
      label: "Double GPO",
      bbox: { x: 0.1, y: 0.1, w: 0.016, h: 0.016 },
    });
    const one = cr.deriveMarkers([], [add]);
    expect(one.markers).toHaveLength(1);
    expect(one.markers[0]).toMatchObject({ source: "human", status: "live", key: "r:ra" });

    const two = cr.deriveMarkers(
      [],
      [add, rev("rd", "2026-07-03T02:00:00Z", { target_review_id: "ra" })],
    );
    expect(two.markers[0]?.status).toBe("deleted");
  });

  it("actions against markers not on this raster are honest no-ops", () => {
    const { markers } = cr.deriveMarkers(
      [det("d1")],
      [rev("r1", "2026-07-03T01:00:00Z", { target_detection_id: "d-elsewhere" })],
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]?.status).toBe("live");
  });
});

describe("countsByEntry (#205)", () => {
  it("groups live markers per entry with removed/added tallies", () => {
    const { markers } = cr.deriveMarkers(
      [det("d1"), det("d2"), det("d3", { legend_entry_id: "le_dl", label: "LED downlight" })],
      [
        rev("r1", "2026-07-03T01:00:00Z", { target_detection_id: "d2" }), // delete one GPO
        rev("ra", "2026-07-03T02:00:00Z", {
          action: "add",
          legend_entry_id: "le_dl",
          label: "LED downlight",
          bbox: { x: 0.2, y: 0.2, w: 0.016, h: 0.016 },
        }),
      ],
    );
    const counts = cr.countsByEntry(markers);
    const gpo = counts.find((c: Row) => c.legendEntryId === "le_gpo");
    const dl = counts.find((c: Row) => c.legendEntryId === "le_dl");
    expect(gpo).toMatchObject({ liveCount: 1, removedCount: 1, addedCount: 0 });
    expect(dl).toMatchObject({ liveCount: 2, removedCount: 0, addedCount: 1 });
    expect(dl?.liveKeys).toContain("r:ra");
  });
});

describe("isAcceptStale (#205)", () => {
  const accepted = (keys: string[]): Row => ({
    legend_entry_id: "le_gpo",
    basis: { markerKeys: keys },
  });

  it("matching key sets → not stale", () => {
    const { markers } = cr.deriveMarkers([det("d1"), det("d2")], []);
    expect(cr.isAcceptStale(accepted(["d:d1", "d:d2"]), markers)).toBe(false);
  });

  it("same COUNT but different instances → stale (a delete plus an add nets the same number)", () => {
    const { markers } = cr.deriveMarkers(
      [det("d1"), det("d2")],
      [
        rev("r1", "2026-07-03T01:00:00Z", { target_detection_id: "d2" }),
        rev("ra", "2026-07-03T02:00:00Z", {
          action: "add",
          legend_entry_id: "le_gpo",
          label: "Double GPO",
          bbox: { x: 0.7, y: 0.7, w: 0.016, h: 0.016 },
        }),
      ],
    );
    expect(cr.isAcceptStale(accepted(["d:d1", "d:d2"]), markers)).toBe(true);
  });

  it("corrections to OTHER entries do not stale this sign-off", () => {
    const { markers } = cr.deriveMarkers(
      [det("d1"), det("d3", { legend_entry_id: "le_dl", label: "LED downlight" })],
      [rev("r1", "2026-07-03T01:00:00Z", { target_detection_id: "d3" })],
    );
    expect(cr.isAcceptStale(accepted(["d:d1"]), markers)).toBe(false);
  });
});
