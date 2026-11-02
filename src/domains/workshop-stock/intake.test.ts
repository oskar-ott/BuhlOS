import { describe, expect, it } from "vitest";
import { absorbLight, cropRect, emptyTracker, findObjects, GONE_MS, SETTLE_MS, stepTracker, type Box, type TrackerState } from "./intake-tracker";
import { draftFor, placedAmount, productWords, sameProduct, sessionTotals } from "./intake";
import { locationText, matrixLocations, rackLabel, ruleFor, rulesOutsideRack, type LocationMatrix } from "./location-matrix";
import { splitLocation } from "./location";
import type { ReadProduct } from "./schema";

/**
 * The camera table's pure logic. What matters most: each object placed is counted
 * exactly once, whatever the hand does around it.
 */

const W = 320;
const H = 180;
const TABLE = 40;

function picture(fill = TABLE): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = fill;
    d[i + 1] = fill;
    d[i + 2] = fill;
    d[i + 3] = 255;
  }
  return d;
}

function paint(d: Uint8ClampedArray, x: number, y: number, w: number, h: number, value = 220) {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const i = (py * W + px) * 4;
      d[i] = value;
      d[i + 1] = value;
      d[i + 2] = value;
    }
  }
}

const frameOf = (data: Uint8ClampedArray) => ({ data, width: W, height: H });

describe("findObjects", () => {
  it("sees nothing on the empty table", () => {
    const found = findObjects(frameOf(picture()), picture());
    expect(found.objects).toEqual([]);
    expect(found.arms).toEqual([]);
    expect(found.changedShare).toBe(0);
  });

  it("finds one object, boxed where it is", () => {
    const f = picture();
    paint(f, 100, 60, 40, 30);
    const { objects, arms } = findObjects(frameOf(f), picture());
    expect(arms).toEqual([]);
    expect(objects).toHaveLength(1);
    const b = objects[0]!;
    expect(b.x).toBeCloseTo(100 / W, 1);
    expect(b.y).toBeCloseTo(60 / H, 1);
    expect(b.w).toBeCloseTo(40 / W, 1);
    expect(b.h).toBeCloseTo(30 / H, 1);
  });

  it("keeps two separated objects apart, and joins a label to its box", () => {
    const f = picture();
    paint(f, 40, 40, 30, 30);
    paint(f, 180, 90, 30, 30);
    expect(findObjects(frameOf(f), picture()).objects).toHaveLength(2);

    const labelled = picture();
    paint(labelled, 100, 60, 40, 12);
    paint(labelled, 100, 76, 40, 12); // a stripe the table's colour runs through it
    expect(findObjects(frameOf(labelled), picture()).objects).toHaveLength(1);
  });

  it("treats a blob touching the edge of the picture as an arm", () => {
    const f = picture();
    paint(f, 0, 70, 90, 20);
    const { objects, arms } = findObjects(frameOf(f), picture());
    expect(objects).toEqual([]);
    expect(arms).toHaveLength(1);
  });

  it("ignores specks, and a light going on across the whole table", () => {
    const speck = picture();
    paint(speck, 100, 60, 6, 6);
    expect(findObjects(frameOf(speck), picture()).objects).toEqual([]);
    const brighter = picture(TABLE + 60);
    expect(findObjects(frameOf(brighter), picture())).toMatchObject({ objects: [], arms: [], changedShare: 0 });
  });

  it("follows slow light changes without absorbing an object", () => {
    const bg = picture();
    const f = picture(TABLE + 10);
    paint(f, 100, 60, 40, 30);
    for (let i = 0; i < 200; i++) absorbLight(bg, frameOf(f));
    expect(bg[0]).toBeGreaterThan(TABLE + 5);
    const i = (70 * W + 110) * 4;
    expect(bg[i]).toBeLessThan(TABLE + 12);
    expect(findObjects(frameOf(f), bg).objects).toHaveLength(1);
  });
});

describe("stepTracker counts each object once", () => {
  const A: Box = { x: 0.3, y: 0.3, w: 0.1, h: 0.1 };
  const B: Box = { x: 0.6, y: 0.5, w: 0.1, h: 0.1 };
  const ARM: Box = { x: 0, y: 0.25, w: 0.35, h: 0.2 };

  function run(frames: Array<{ objects?: Box[]; arms?: Box[]; ms: number }>) {
    let state: TrackerState = emptyTracker();
    let now = 1000;
    const settled: number[] = [];
    const gone: number[] = [];
    for (const f of frames) {
      const end = now + f.ms;
      for (; now < end; now += 150) {
        const step = stepTracker(state, { objects: f.objects ?? [], arms: f.arms ?? [] }, now);
        state = step.state;
        settled.push(...step.settled.map((t) => t.id));
        gone.push(...step.gone.map((t) => t.id));
      }
    }
    return { state, settled, gone };
  }

  it("counts an object once it sits still, and only once", () => {
    const { settled } = run([{ objects: [A], ms: SETTLE_MS + 5000 }]);
    expect(settled).toEqual([1]);
  });

  it("doesn't count something that doesn't stay", () => {
    const { settled, state } = run([{ objects: [A], ms: 300 }, { ms: GONE_MS + 300 }]);
    expect(settled).toEqual([]);
    expect(state.tracks).toEqual([]);
  });

  it("doesn't count while the object is still moving", () => {
    const frames = Array.from({ length: 12 }, (_, i) => ({ objects: [{ ...A, x: 0.2 + i * 0.03 }], ms: 150 }));
    expect(run(frames).settled).toEqual([]);
  });

  it("doesn't count an arm, and waits for the hand to leave", () => {
    expect(run([{ arms: [ARM], ms: 4000 }]).settled).toEqual([]);
    const { settled } = run([{ objects: [A], arms: [ARM], ms: 3000 }, { objects: [A], ms: SETTLE_MS + 300 }]);
    expect(settled).toEqual([1]);
  });

  it("doesn't count an object again when an arm covers it for a while", () => {
    const { settled, gone } = run([{ objects: [A], ms: SETTLE_MS + 300 }, { arms: [ARM], ms: 6000 }, { objects: [A], ms: 2000 }]);
    expect(settled).toEqual([1]);
    expect(gone).toEqual([]);
  });

  it("doesn't count a nudged object again", () => {
    const { settled } = run([{ objects: [A], ms: SETTLE_MS + 300 }, { objects: [{ ...A, x: A.x + 0.02, y: A.y + 0.01 }], ms: 2000 }]);
    expect(settled).toEqual([1]);
  });

  it("counts two objects, and a second placed later, once each", () => {
    expect(run([{ objects: [A, B], ms: SETTLE_MS + 300 }]).settled).toEqual([1, 2]);
    expect(run([{ objects: [A], ms: SETTLE_MS + 300 }, { objects: [A, B], ms: SETTLE_MS + 300 }]).settled).toEqual([1, 2]);
  });

  it("counts the next one placed where the last was lifted away", () => {
    const { settled, gone } = run([{ objects: [A], ms: SETTLE_MS + 300 }, { ms: GONE_MS + 300 }, { objects: [A], ms: SETTLE_MS + 300 }]);
    expect(gone).toEqual([1]);
    expect(settled).toEqual([1, 2]);
  });

  it("flags objects pushed together, then counts one that's moved apart", () => {
    const merged: Box = { x: 0.3, y: 0.3, w: 0.22, h: 0.1 };
    const pushed = run([{ objects: [A], ms: SETTLE_MS + 300 }, { objects: [merged], ms: 1000 }]);
    expect(pushed.settled).toEqual([1]);
    expect(pushed.state.tracks[0]!.touching).toBe(true);
    const apart = run([{ objects: [A], ms: SETTLE_MS + 300 }, { objects: [merged], ms: 1000 }, { objects: [A, B], ms: SETTLE_MS + 300 }]);
    expect(apart.settled).toEqual([1, 2]);
    expect(apart.state.tracks[0]!.touching).toBe(false);
  });
});

describe("cropRect", () => {
  it("adds a margin and stays inside the frame", () => {
    expect(cropRect({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, 1000, 1000, 0.1)).toEqual({ x: 490, y: 490, w: 120, h: 120 });
    const atCorner = cropRect({ x: 0, y: 0.95, w: 0.1, h: 0.05 }, 1000, 1000, 0.5);
    expect(atCorner.x).toBe(0);
    expect(atCorner.y + atCorner.h).toBe(1000);
  });
});

const matrix: LocationMatrix = {
  racks: [{ id: "c", name: "C", shelves: 4, bins: 6 }, { id: "bay", name: "Cable bay", shelves: 1, bins: 2 }],
  rules: [
    { id: "1", words: "iconic", rackId: "c", shelf: 1, bin: 1 },
    { id: "2", words: "iconic switches", rackId: "c", shelf: 2, bin: 4 },
    { id: "3", words: "power point", rackId: "c", shelf: 3, bin: 1 },
    { id: "4", words: "tps", rackId: "bay", shelf: 1, bin: 2 },
    { id: "5", words: "orphan", rackId: "gone", shelf: 1, bin: 1 },
  ],
};

describe("location matrix", () => {
  it("names a location the by-shelf list already understands", () => {
    expect(rackLabel("c")).toBe("Rack C");
    expect(rackLabel("Cable bay")).toBe("Cable bay");
    const text = locationText(matrix.racks[0]!, 2, 4);
    expect(text).toBe("Rack C Shelf 2, Bin 4");
    expect(splitLocation(text)).toEqual({ shelf: "Rack C Shelf 2", bin: "Bin 4" });
  });

  it("the most specific rule wins, whatever order they're in", () => {
    expect(ruleFor("Clipsal Iconic 1 Gang Switch Mechanism", matrix)?.location).toBe("Rack C Shelf 2, Bin 4");
    expect(ruleFor("Clipsal Iconic cover plate", matrix)?.location).toBe("Rack C Shelf 1, Bin 1");
    const reversed = { ...matrix, rules: [...matrix.rules].reverse() };
    expect(ruleFor("Clipsal Iconic 1 Gang Switch Mechanism", reversed)?.location).toBe("Rack C Shelf 2, Bin 4");
  });

  it("every word must be there, compared the way the list search compares", () => {
    expect(ruleFor("Clipsal 30M switch", matrix)).toBeNull();
    expect(ruleFor("Iconic switches, pack of 10", matrix)?.rule.id).toBe("2");
    expect(ruleFor("Double GPO 10A", matrix)?.rule.id).toBe("3");
    expect(ruleFor("Twin and earth 2.5mm", matrix)?.location).toBe("Cable bay Shelf 1, Bin 2");
  });

  it("nothing to go on, no location", () => {
    expect(ruleFor("", matrix)).toBeNull();
    expect(ruleFor(null, matrix)).toBeNull();
    expect(ruleFor("iconic", null)).toBeNull();
    expect(ruleFor("orphan", matrix)).toBeNull();
  });

  it("lists its bins and refuses to strand a rule", () => {
    expect(matrixLocations(matrix)).toEqual(["Cable bay Shelf 1, Bin 2", "Rack C Shelf 1, Bin 1", "Rack C Shelf 2, Bin 4", "Rack C Shelf 3, Bin 1"]);
    expect(rulesOutsideRack(matrix, "c", 2, 6).map((r) => r.id)).toEqual(["3"]);
    expect(rulesOutsideRack(matrix, "c", 4, 3).map((r) => r.id)).toEqual(["2"]);
    expect(rulesOutsideRack(matrix, "c", 4, 6)).toEqual([]);
  });
});

const product = (over: Partial<ReadProduct> = {}): ReadProduct => ({
  brand: "Clipsal", manufacturerCode: "3041", supplierSku: null, supplierName: null, description: "Iconic 1 gang switch",
  colourFinish: null, variantDetails: ["16A"], barcode: null, packQuantity: null, packUnit: null, labelText: [], position: "only product", ...over,
});

describe("how much one placed object adds", () => {
  it("is 1 when loose, the printed size on a pack", () => {
    expect(placedAmount("each", product())).toEqual({ milli: 1000, fromLabel: false });
    expect(placedAmount("each", null)).toEqual({ milli: 1000, fromLabel: false });
    expect(placedAmount("each", product({ packQuantity: 10, packUnit: "each" }))).toEqual({ milli: 10000, fromLabel: true });
    expect(placedAmount("each", product({ packQuantity: 10, packUnit: null }))).toEqual({ milli: 10000, fromLabel: true });
  });

  it("an item counted in boxes adds one box, whatever's printed", () => {
    expect(placedAmount("box", product({ packQuantity: 10, packUnit: "each" }))).toEqual({ milli: 1000, fromLabel: false });
  });

  it("never guesses a length", () => {
    expect(placedAmount("metre", product())).toBeNull();
    expect(placedAmount("metre", product({ packQuantity: 100, packUnit: "metre" }))).toEqual({ milli: 100000, fromLabel: true });
    expect(placedAmount("each", product({ packQuantity: 100, packUnit: "metre" }))).toEqual({ milli: 1000, fromLabel: false });
  });
});

describe("a new item's draft", () => {
  it("takes its name and matrix location from the label", () => {
    const d = draftFor(product(), matrix);
    expect(d.name).toContain("Clipsal Iconic 1 gang switch");
    expect(d).toMatchObject({ unit: "each", amount: "1", location: "Rack C Shelf 2, Bin 4", locationFrom: "iconic switches" });
    expect(productWords(product())).toContain("3041");
  });

  it("guesses the item type from the label, so it files with its kind on the phone", () => {
    expect(draftFor(product(), matrix).category).toBe("switches");
    expect(draftFor(product(), matrix).specs).toMatchObject({ range: "Iconic" });
  });

  it("uses a printed pack, a printed length, and leaves what it doesn't know blank", () => {
    expect(draftFor(product({ packQuantity: 10, packUnit: "each" }), matrix).amount).toBe("10");
    expect(draftFor(product({ packQuantity: 100, packUnit: "metre" }), matrix)).toMatchObject({ unit: "metre", amount: "100" });
    expect(draftFor(null, null)).toEqual({ name: "", unit: "each", amount: "1", location: "", locationFrom: null, category: null, specs: {} });
  });
});

describe("sameProduct: only printed evidence", () => {
  it("matches on barcode or code, never on words", () => {
    expect(sameProduct({ barcode: "9300000000019" }, { barcode: "9300000000019" })).toBe(true);
    expect(sameProduct({ barcode: "9300000000019" }, { barcode: "9300000000026" })).toBe(false);
    expect(sameProduct({ product: product() }, { product: product({ manufacturerCode: "30-41" }) })).toBe(true);
    expect(sameProduct({ product: product() }, { product: product({ manufacturerCode: "3042" }) })).toBe(false);
    expect(sameProduct({ product: product({ manufacturerCode: null }) }, { product: product({ manufacturerCode: null }) })).toBe(false);
    expect(sameProduct({ product: product({ manufacturerCode: null, supplierSku: "RX-1" }) }, { product: product({ manufacturerCode: null, supplierSku: "rx1" }) })).toBe(true);
  });

  it("two different barcodes aren't the same even with the same code", () => {
    expect(sameProduct({ barcode: "9300000000019", product: product() }, { barcode: "9300000000026", product: product() })).toBe(false);
  });
});

describe("session totals", () => {
  it("adds up logged placements by item, and leaves out undone and waiting", () => {
    const row = (itemId: string | null, amountMilli: number | null, status = "logged") => ({ status, itemId, itemName: itemId ? `Item ${itemId}` : null, unit: "each" as const, location: null, amountMilli });
    const lines = sessionTotals([row("a", 1000), row("b", 10000), row("a", 1000), row("a", 1000, "undone"), row(null, null, "new")]);
    expect(lines.map((l) => [l.itemId, l.milli, l.placements])).toEqual([["a", 2000, 2], ["b", 10000, 1]]);
  });
});
