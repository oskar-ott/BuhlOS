import { describe, expect, it } from "vitest";
import { binCode, binLabels, layoutBinLabel, pickedLabels, rackLabels } from "./bin-label";
import { fitToPrinthead, LABEL_SIZES, labelSize } from "./label";
import type { LocationMatrix } from "./location-matrix";

/**
 * Bin labels (owner, 2026-11-05: "one label is the location code like A2 B3 … the other label has contents", "like 2 gang switches").
 * Racks numbered, shelves lettered, bins numbered (#1128) — the code is "3B-4" (owner's pick).
 */

const matrix: LocationMatrix = {
  racks: [
    { id: "ra", name: "3", shelves: 2, bins: 3 },
    { id: "rc", name: "Cable bay", shelves: 1, bins: 2 },
  ],
  rules: [
    { id: "1", words: "2 gang switches", rackId: "ra", shelf: 2, bin: 3 },
    { id: "2", words: "iconic dimmer", rackId: "ra", shelf: 2, bin: 3 },
    { id: "3", words: "TPS 2.5mm", rackId: "rc", shelf: 1, bin: 1 },
  ],
};
const rackA = matrix.racks[0]!;
const bay = matrix.racks[1]!;

describe("bin labels", () => {
  it("the code is 3B-4 for rack 3, shelf B, bin 4 — a rack named in words keeps its name", () => {
    expect(binCode({ name: "3" }, 2, 4)).toBe("3B-4");
    expect(binCode(rackA, 2, 3)).toBe("3B-3");
    expect(binCode({ name: "12" }, 26, 60)).toBe("12Z-60");
    expect(binCode(bay, 1, 2)).toBe("Cable bay A-2");
  });

  it("a bin has its code label and its contents label — each picked on its own (owner, 2026-11-06: pick which labels)", () => {
    const all = binLabels(matrix, rackA, 2, 3);
    expect(all.map((l) => l.kind)).toEqual(["code", "contents"]);
    expect(all[1]).toMatchObject({ code: "3B-3", place: "Rack 3 · Shelf B · Bin 3", contents: ["2 gang switches", "iconic dimmer"] });
    expect(pickedLabels(all, { code: true, contents: true }).map((l) => l.kind)).toEqual(["code", "contents"]);
    expect(pickedLabels(all, { code: true, contents: false }).map((l) => l.kind)).toEqual(["code"]);
    expect(pickedLabels(all, { code: false, contents: true }).map((l) => l.kind)).toEqual(["contents"]);
    expect(pickedLabels(all, { code: false, contents: false })).toEqual([]);
  });

  it("a bin with nothing set has its code label only — never an empty contents label", () => {
    expect(binLabels(matrix, rackA, 1, 1).map((l) => l.kind)).toEqual(["code"]);
    expect(pickedLabels(binLabels(matrix, rackA, 1, 1), { code: false, contents: true })).toEqual([]);
  });

  it("a rack's picked labels come shelf by shelf, bin by bin, the way they sit", () => {
    const all = rackLabels(matrix, rackA, { code: true, contents: true });
    expect(all.map((l) => `${l.code} ${l.kind}`)).toEqual([
      "3A-1 code", "3A-2 code", "3A-3 code",
      "3B-1 code", "3B-2 code", "3B-3 code", "3B-3 contents",
    ]);
    expect(rackLabels(matrix, rackA, { code: false, contents: true })).toHaveLength(1);
    expect(rackLabels(matrix, rackA, { code: true, contents: false })).toHaveLength(6);
    expect(rackLabels(matrix, rackA, { code: false, contents: false })).toEqual([]);
    expect(rackLabels(matrix, bay, { code: true, contents: true })).toHaveLength(3);
  });

  it("a rack whose shelves have their own bin counts (#1136) gets a label for each bin that's there — no more, no fewer", () => {
    const uneven = { id: "ru", name: "4", shelves: 3, bins: 8, shelfBins: [8, 8, 3] };
    const labels = rackLabels({ racks: [uneven], rules: [] }, uneven, { code: true, contents: true });
    expect(labels).toHaveLength(19);
    expect(labels.filter((l) => l.code.startsWith("4C")).map((l) => l.code)).toEqual(["4C-1", "4C-2", "4C-3"]);
    expect(labels.at(-1)!.code).toBe("4C-3");
  });

  it("every label size, both kinds, as printed on a B1 (48 mm head): all text inside the label", () => {
    const long = { kind: "contents" as const, code: "Cable bay Z-60", place: "Cable bay · Shelf Z · Bin 60", contents: ["2 gang switches", "iconic dimmer", "clipsal 2000 series 4 gang light switch plate"] };
    for (const s of LABEL_SIZES) {
      for (const head of [{ px: 384, dir: "top" as const }, { px: 96, dir: "left" as const }]) {
        const size = fitToPrinthead(s, head.px, head.dir);
        for (const spec of [{ ...long, kind: "code" as const }, long]) {
          const lay = layoutBinLabel(size, spec);
          expect(lay.width).toBe(size.widthMm * 8);
          for (const line of lay.lines) {
            expect(line.y).toBeGreaterThanOrEqual(0);
            expect(line.y + line.size).toBeLessThanOrEqual(lay.height);
            expect(line.size).toBeGreaterThanOrEqual(12);
          }
        }
      }
    }
  });

  it("the code label is the code, large — on a 50 × 30 label it fills most of the height, the place in words under it", () => {
    const lay = layoutBinLabel(fitToPrinthead(labelSize("50x30"), 384, "top"), binLabels(matrix, rackA, 2, 3)[0]!);
    expect(lay.width).toBe(384);
    expect(lay.lines.map((l) => l.text)).toEqual(["3B-3", "Rack 3 · Shelf B · Bin 3"]);
    expect(lay.lines[0]!.size).toBeGreaterThan(lay.height * 0.6);
    expect(lay.lines[0]!.bold).toBe(true);
  });

  it("the contents label: the code on top, then each thing on its own line, smaller than the code and centred", () => {
    const lay = layoutBinLabel(labelSize("40x30"), { kind: "contents", code: "3B-3", place: "", contents: ["2 gang switches", "iconic dimmer"] });
    expect(lay.lines.map((l) => l.text)).toEqual(["3B-3", "2 gang switches", "iconic dimmer"]);
    const [code, ...body] = lay.lines;
    expect(code!.bold).toBe(true);
    for (const l of body) expect(l.size).toBeLessThan(code!.size);
    // centred: as much white above the code as below the last line, give or take a dot or two
    const below = lay.height - (body.at(-1)!.y + body.at(-1)!.size);
    expect(Math.abs(code!.y - below)).toBeLessThanOrEqual(2);
  });

  it("more than fits: the list runs on at the smallest size and is cut with …, never past the label's edge", () => {
    const many = Array.from({ length: 12 }, (_, i) => `clipsal iconic 2000 series part ${i + 1}`);
    const lay = layoutBinLabel(labelSize("40x12"), { kind: "contents", code: "3B-3", place: "", contents: many });
    expect(lay.lines.at(-1)!.text.endsWith("…")).toBe(true);
    for (const l of lay.lines) expect(l.y + l.size).toBeLessThanOrEqual(lay.height);
  });
});
