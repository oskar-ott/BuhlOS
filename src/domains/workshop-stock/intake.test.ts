import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { absorbLight, addCalibrationFrame, cropRect, emptyTracker, finishCalibration, findObjects, GONE_MS, newCalibration, SETTLE_MS, sharpness, stepTracker, tableAdvice, type Box, type TrackerState } from "./intake-tracker";
import { draftFor, emptyScan, feedScan, identifiersToTeach, packNeedsCheck, placedAmount, productWords, sameInARow, sameProduct, sessionTotals, waitingQueue } from "./intake";
import { locationText, matrixLocations, rackLabel, ruleFor, rulesOutsideRack, type LocationMatrix } from "./location-matrix";
import { splitLocation } from "./location";
import type { ReadProduct, StockItem } from "./schema";

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
    const { settled, gone } = run([{ objects: [A], ms: SETTLE_MS + 300 }, { arms: [A], ms: 300 }, { ms: GONE_MS + 300 }, { objects: [A], ms: SETTLE_MS + 300 }]);
    expect(gone).toEqual([1]);
    expect(settled).toEqual([1, 2]);
  });

  it("nothing leaves unless a hand was over it: a shadow or the light can't count it twice", () => {
    const { settled, gone } = run([{ objects: [A], ms: SETTLE_MS + 300 }, { ms: 5000 }, { objects: [A], ms: SETTLE_MS + 300 }]);
    expect(gone).toEqual([]);
    expect(settled).toEqual([1]);
  });

  it("something unseen for a long time has gone anyway, even with no hand seen", () => {
    const { gone } = run([{ objects: [A], ms: SETTLE_MS + 300 }, { ms: 31_000 }]);
    expect(gone).toEqual([1]);
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
    const bins = matrixLocations(matrix);
    expect(bins).toHaveLength(matrix.racks.reduce((n, r) => n + r.shelves * r.bins, 0));
    expect(bins).toEqual(expect.arrayContaining(["Cable bay Shelf 1, Bin 2", "Rack C Shelf 2, Bin 4", "Rack C Shelf 4, Bin 6"]));
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

describe("what a placed object teaches and asks", () => {
  const id = (kind: string, value: string) => ({ id: value, kind, value, valueKey: value.toUpperCase().replace(/[^A-Z0-9]/g, ""), scope: null }) as unknown as StockItem["identifiers"][number];
  const noCodes = { barcode: null, manufacturerCode: null, supplierSku: null, supplierName: null };

  it("a large or changed pack size asks once, then is trusted", () => {
    const none = new Set<string>();
    expect(packNeedsCheck(10_000, "a", none, [])).toBe(false);
    expect(packNeedsCheck(100_000, "a", none, [])).toBe(true);
    expect(packNeedsCheck(10_000, "a", none, [10_000])).toBe(false);
    expect(packNeedsCheck(20_000, "a", none, [10_000])).toBe(true);
    expect(packNeedsCheck(100_000, "a", new Set(["a:100000"]), [])).toBe(false);
    expect(packNeedsCheck(100_000, "b", new Set(["a:100000"]), [])).toBe(true);
  });

  it("a pick teaches every printed code the item lacks, and only those", () => {
    expect(identifiersToTeach({ identifiers: [] }, "9300000000019", { ...noCodes, manufacturerCode: "30M-WE", supplierSku: "ABC1", supplierName: "Rexel" })).toEqual([
      { kind: "barcode", value: "9300000000019" },
      { kind: "manufacturer_code", value: "30M-WE" },
      { kind: "supplier_sku", value: "ABC1", supplierName: "Rexel" },
    ]);
    expect(identifiersToTeach({ identifiers: [id("manufacturer_code", "30MWE")] }, null, { ...noCodes, manufacturerCode: "30M-WE" })).toEqual([]);
    expect(identifiersToTeach({ identifiers: [] }, null, { ...noCodes, barcode: "9300000000019" })).toEqual([{ kind: "barcode", value: "9300000000019" }]);
    expect(identifiersToTeach({ identifiers: [] }, null, null)).toEqual([]);
  });

  it("an exact match only keeps the barcode", () => {
    expect(identifiersToTeach({ identifiers: [] }, "9300000000019", { ...noCodes, manufacturerCode: "3041" }, { barcodeOnly: true })).toEqual([{ kind: "barcode", value: "9300000000019" }]);
  });

  it("counts the same thing in a row, newest first", () => {
    const row = (itemId: string, amountMilli = 1000, status = "logged") => ({ status, itemId, amountMilli });
    expect(sameInARow([])).toBe(0);
    expect(sameInARow([row("a"), row("a"), row("b"), row("a")])).toBe(2);
    expect(sameInARow([row("a"), row("x", 1000, "undone"), row("a")])).toBe(2);
    expect(sameInARow([row("a", 10_000), row("a", 1000)])).toBe(1);
  });

  it("tells a scanner from a person typing", () => {
    let buffer = emptyScan();
    let code: string | null = null;
    let now = 1000;
    for (const key of "9300000000019") {
      ({ buffer, code } = feedScan(buffer, key, now));
      now += 5;
    }
    ({ code, buffer } = feedScan(buffer, "Enter", now));
    expect(code).toBe("9300000000019");
    // A person: the same keys, far apart.
    now = 5000;
    for (const key of "9300000") {
      ({ buffer, code } = feedScan(buffer, key, now));
      now += 200;
    }
    expect(feedScan(buffer, "Enter", now).code).toBeNull();
    // A shortcut key and Enter close together aren't a scan: too short.
    buffer = emptyScan();
    ({ buffer } = feedScan(buffer, "u", 9000));
    expect(feedScan(buffer, "Enter", 9001).code).toBeNull();
  });

  it("queues oldest first, repeats of one product on one card", () => {
    const code = (manufacturerCode: string | null) => ({ barcode: null, manufacturerCode, supplierSku: null });
    const q = waitingQueue([{ id: 3, product: code("A") }, { id: 2, product: code("B") }, { id: 1, product: code("A") }, { id: 4, product: code(null) }, { id: 5, product: code(null) }]);
    expect(q.map((g) => [g.lead.id, g.repeats.map((r) => r.id)])).toEqual([[1, [3]], [2, []], [4, []], [5, []]]);
  });
});

describe("reading the empty table", () => {
  function frames(fill: (x: number, y: number, n: number) => number, count = 8) {
    const c = newCalibration();
    for (let n = 0; n < count; n++) {
      const data = new Uint8ClampedArray(320 * 180 * 4);
      for (let y = 0; y < 180; y++) {
        for (let x = 0; x < 320; x++) {
          const v = fill(x, y, n);
          data.set([v, v, v, 255], (y * 320 + x) * 4);
        }
      }
      addCalibrationFrame(c, { data, width: 320, height: 180 });
    }
    return c;
  }

  it("a still table reads clean", () => {
    const read = finishCalibration(frames(() => 120))!;
    expect(read.check.moved).toBe(false);
    expect(read.threshold).toBe(20);
    expect(tableAdvice(read.check)).toBeNull();
  });

  it("notices something moving through", () => {
    const read = finishCalibration(frames((x, y, n) => (n > 3 && x > 100 && x < 200 && y > 50 && y < 120 ? 220 : 120)))!;
    expect(read.check.moved).toBe(true);
    expect(tableAdvice(read.check)?.code).toBe("moved");
  });

  it("says when it's too dark, or blown out", () => {
    expect(tableAdvice(finishCalibration(frames(() => 20))!.check)?.code).toBe("dark");
    expect(tableAdvice(finishCalibration(frames(() => 255))!.check)?.code).toBe("blown");
  });

  it("raises the threshold on a grainy picture", () => {
    const read = finishCalibration(frames((x, y, n) => 120 + (((x * 7 + y * 13 + n * 31) % 37) - 18)))!;
    expect(read.check.noise).toBeGreaterThan(5);
    expect(read.threshold).toBeGreaterThan(20);
    expect(read.threshold).toBeLessThanOrEqual(40);
  });

  it("scores an in-focus picture above a blurred one", () => {
    const sharp = new Uint8ClampedArray(64 * 64 * 4);
    const blurred = new Uint8ClampedArray(64 * 64 * 4);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const s = x % 8 < 4 ? 40 : 220;
        const b = 130 + 90 * Math.sin((x / 8) * 2 * Math.PI);
        sharp.set([s, s, s, 255], (y * 64 + x) * 4);
        blurred.set([b, b, b, 255], (y * 64 + x) * 4);
      }
    }
    expect(sharpness({ data: sharp, width: 64, height: 64 })).toBeGreaterThan(sharpness({ data: blurred, width: 64, height: 64 }) * 5);
  });
});

describe("scoring a label read (scripts/qa/label-reader-compare.js)", () => {
  const { scoreRead } = createRequire(import.meta.url)("../../../scripts/qa/label-reader-compare.js") as { scoreRead: (p: unknown, c: Array<{ value: string }>) => string };
  it("a wrong code is told apart from no code: only one of them can log the wrong item", () => {
    expect(scoreRead({ manufacturerCode: "3041" }, [{ value: "3041" }])).toBe("right");
    expect(scoreRead({ manufacturerCode: "3042" }, [{ value: "3041" }])).toBe("wrong");
    expect(scoreRead({ manufacturerCode: null }, [{ value: "3041" }])).toBe("no_code");
    expect(scoreRead({ manufacturerCode: "3041" }, [])).toBe("unverifiable");
    expect(scoreRead(null, [{ value: "3041" }])).toBe("no_code");
  });
});
