import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * #211 — the pure cable-estimate engine (api/_lib/cable-estimate.js):
 * calibration → mm-per-normalised-unit, Manhattan runs to the nearest
 * board, factor application, and the refusals that keep a heuristic from
 * masquerading as a measurement.
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CJS module under test
const ce: any = requireFromHere("../../../api/_lib/cable-estimate.js");

type Row = Record<string, unknown>;

const marker = (key: string, cx: number, cy: number, over: Row = {}): Row => ({
  key,
  status: "live",
  bbox: { x: cx - 0.01, y: cy - 0.01, w: 0.02, h: 0.02 },
  legendEntryId: "le_gpo",
  label: "Double GPO",
  ...over,
});

describe("calibrationScales (#211)", () => {
  it("a horizontal reference fixes both axes via the raster aspect", () => {
    // half the page width = 10,000mm on a page whose raster is 2:1 (w:h)
    const cal = ce.calibrationScales({ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }, 10_000, 0.5);
    expect(cal.mmPerNormX).toBeCloseTo(20_000, 6); // full width 20m
    expect(cal.mmPerNormY).toBeCloseTo(10_000, 6); // full height = width × aspect
  });

  it("a diagonal reference resolves exactly through the aspect", () => {
    // aspect 1 (square): diagonal Δ(0.3, 0.4) at 5,000mm → norm span 0.5 → 10,000/unit
    const cal = ce.calibrationScales({ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.5 }, 5_000, 1);
    expect(cal.mmPerNormX).toBeCloseTo(10_000, 6);
    expect(cal.mmPerNormY).toBeCloseTo(10_000, 6);
  });

  it("refuses too-short references and non-positive distances — never a guessed unit", () => {
    expect(
      ce.calibrationScales({ x: 0.5, y: 0.5 }, { x: 0.505, y: 0.5 }, 1000, 1).error,
    ).toContain("too close");
    expect(ce.calibrationScales({ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }, 0, 1).error).toContain(
      "positive",
    );
    expect(
      ce.calibrationScales({ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }, 1000, 0).error,
    ).toContain("aspect");
  });
});

describe("estimateRun (#211)", () => {
  // square raster, full page = 10m × 10m
  const CAL = { mmPerNormX: 10_000, mmPerNormY: 10_000 };
  const NO_EXTRAS = { routingFactor: 1, riseDropMm: 0, slackFactor: 1 };

  it("runs each device to its NEAREST board by Manhattan distance", () => {
    const pins = [
      { board_identifier: "DB-1", point: { x: 0.1, y: 0.1 } },
      { board_identifier: "DB-2", point: { x: 0.9, y: 0.9 } },
    ];
    const out = ce.estimateRun(
      [marker("d:near1", 0.2, 0.1), marker("d:near2", 0.8, 0.9)],
      pins,
      CAL,
      NO_EXTRAS,
    );
    expect(out.perDevice[0]).toMatchObject({
      boardIdentifier: "DB-1",
      manhattanMm: 1000, // |0.2-0.1| × 10,000
      estimateMm: 1000,
    });
    expect(out.perDevice[1]).toMatchObject({ boardIdentifier: "DB-2", estimateMm: 1000 });
    expect(out.totalMm).toBe(2000);
  });

  it("applies routing, slack and rise/drop factors visibly", () => {
    const out = ce.estimateRun(
      [marker("d:1", 0.5, 0.1)], // manhattan 4,000mm from the pin
      [{ board_identifier: "DB", point: { x: 0.1, y: 0.1 } }],
      CAL,
      { routingFactor: 1.5, riseDropMm: 4000, slackFactor: 1.1 },
    );
    // 4000 × 1.5 × 1.1 + 4000 = 10,600
    expect(out.perDevice[0]?.estimateMm).toBe(10_600);
    expect(out.factors).toEqual({ routingFactor: 1.5, riseDropMm: 4000, slackFactor: 1.1 });
  });

  it("asymmetric page scales weight x and y independently", () => {
    const out = ce.estimateRun(
      [marker("d:1", 0.2, 0.2)],
      [{ board_identifier: "DB", point: { x: 0.1, y: 0.1 } }],
      { mmPerNormX: 10_000, mmPerNormY: 20_000 },
      NO_EXTRAS,
    );
    // 0.1 × 10,000 + 0.1 × 20,000 = 3,000
    expect(out.perDevice[0]?.manhattanMm).toBe(3000);
  });

  it("rolls up per board and per label; deleted markers are excluded", () => {
    const out = ce.estimateRun(
      [
        marker("d:1", 0.2, 0.1),
        marker("d:2", 0.3, 0.1),
        marker("d:3", 0.2, 0.3, { legendEntryId: "le_dl", label: "LED downlight" }),
        marker("d:dead", 0.4, 0.1, { status: "deleted" }),
      ],
      [{ board_identifier: "DB-1", point: { x: 0.1, y: 0.1 } }],
      CAL,
      NO_EXTRAS,
    );
    expect(out.deviceCount).toBe(3);
    expect(out.boards).toHaveLength(1);
    const board = out.boards[0];
    expect(board.deviceCount).toBe(3);
    expect(board.byLabel).toHaveLength(2);
    const dl = board.byLabel.find((l: Row) => l.label === "LED downlight");
    const gpo = board.byLabel.find((l: Row) => l.label === "Double GPO");
    expect(dl).toMatchObject({ deviceCount: 1, totalMm: 3000 });
    expect(gpo).toMatchObject({ deviceCount: 2, totalMm: 3000 });
    expect(board.totalMm).toBe(1000 + 2000 + 3000);
  });

  it("refuses to estimate with no board pinned", () => {
    const out = ce.estimateRun([marker("d:1", 0.2, 0.1)], [], CAL, NO_EXTRAS);
    expect(out.error).toContain("no board");
  });

  it("clamps nonsense factors back to the visible defaults", () => {
    const f = ce.normaliseFactors({ routingFactor: -3, riseDropMm: "??", slackFactor: 99 });
    expect(f).toEqual(ce.DEFAULT_FACTORS);
  });
});
