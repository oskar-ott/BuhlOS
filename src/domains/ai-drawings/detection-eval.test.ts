import { describe, expect, it } from "vitest";
import { boxIoU, scoreDetections, type EvalBox } from "./detection-eval";

/**
 * #204 — the detection eval scorer. Pure math, no model: every prompt/model
 * change gets measured through this, so its own honesty matters most —
 * label confusion must cost BOTH a false positive and a false negative,
 * double-matching must be impossible, and undefined metrics stay null
 * instead of masquerading as 0 or 1.
 */

const box = (label: string, x: number, y: number, w = 0.02, h = 0.02): EvalBox => ({
  label,
  bbox: { x, y, w, h },
});

describe("boxIoU", () => {
  it("identical boxes → 1; disjoint → 0; half-overlap in between", () => {
    expect(boxIoU({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, { x: 0.1, y: 0.1, w: 0.2, h: 0.2 })).toBe(1);
    expect(boxIoU({ x: 0, y: 0, w: 0.1, h: 0.1 }, { x: 0.5, y: 0.5, w: 0.1, h: 0.1 })).toBe(0);
    const half = boxIoU({ x: 0, y: 0, w: 0.2, h: 0.1 }, { x: 0.1, y: 0, w: 0.2, h: 0.1 });
    expect(half).toBeCloseTo(1 / 3, 5);
  });
});

describe("scoreDetections", () => {
  it("perfect detection → P=R=F1=1 per label and overall", () => {
    const ref = [box("GPO", 0.1, 0.1), box("GPO", 0.5, 0.5), box("DL", 0.3, 0.3)];
    const out = scoreDetections(ref, ref);
    expect(out.overall).toMatchObject({ tp: 3, fp: 0, fn: 0, precision: 1, recall: 1, f1: 1 });
    expect(out.perLabel.GPO).toMatchObject({ tp: 2, fp: 0, fn: 0 });
  });

  it("a miss is a false negative; an extra is a false positive", () => {
    const ref = [box("GPO", 0.1, 0.1), box("GPO", 0.5, 0.5)];
    const det = [box("GPO", 0.1, 0.1), box("GPO", 0.8, 0.8)];
    const out = scoreDetections(det, ref);
    expect(out.perLabel.GPO).toMatchObject({ tp: 1, fp: 1, fn: 1 });
    expect(out.overall.precision).toBeCloseTo(0.5, 5);
    expect(out.overall.recall).toBeCloseTo(0.5, 5);
  });

  it("label confusion costs a false positive AND a false negative", () => {
    const ref = [box("GPO", 0.1, 0.1)];
    const det = [box("DL", 0.1, 0.1)]; // right place, wrong label
    const out = scoreDetections(det, ref);
    expect(out.perLabel.DL).toMatchObject({ tp: 0, fp: 1, fn: 0 });
    expect(out.perLabel.GPO).toMatchObject({ tp: 0, fp: 0, fn: 1 });
    expect(out.overall).toMatchObject({ tp: 0, fp: 1, fn: 1 });
  });

  it("one reference box can only be matched once (no double credit)", () => {
    const ref = [box("GPO", 0.1, 0.1)];
    const det = [box("GPO", 0.1, 0.1), box("GPO", 0.105, 0.105)]; // both overlap the same ref
    const out = scoreDetections(det, ref);
    expect(out.perLabel.GPO).toMatchObject({ tp: 1, fp: 1, fn: 0 });
  });

  it("greedy matching pairs the higher-IoU couple first", () => {
    const ref = [box("GPO", 0.1, 0.1, 0.04, 0.04)];
    const det = [
      box("GPO", 0.11, 0.11, 0.04, 0.04), // decent overlap
      box("GPO", 0.1, 0.1, 0.04, 0.04), // exact — must win the match
    ];
    const out = scoreDetections(det, ref);
    expect(out.perLabel.GPO).toMatchObject({ tp: 1, fp: 1 });
  });

  it("below the IoU threshold nothing matches", () => {
    const ref = [box("GPO", 0.1, 0.1)];
    const det = [box("GPO", 0.115, 0.115)]; // tiny boxes, slight offset → low IoU
    const out = scoreDetections(det, ref, 0.9);
    expect(out.perLabel.GPO).toMatchObject({ tp: 0, fp: 1, fn: 1 });
  });

  it("undefined metrics stay null — never fake 0 or 1", () => {
    const out = scoreDetections([], [box("GPO", 0.1, 0.1)]);
    expect(out.perLabel.GPO!.precision).toBe(null); // nothing predicted
    expect(out.perLabel.GPO!.recall).toBe(0);
    const out2 = scoreDetections([box("GPO", 0.1, 0.1)], []);
    expect(out2.perLabel.GPO!.recall).toBe(null); // nothing to find
  });
});
