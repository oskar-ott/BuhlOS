import { describe, expect, it } from "vitest";
import { binCode, binLabels, layoutBinLabel, rackLabels } from "./bin-label";
import { fitToPrinthead, LABEL_SIZES, labelSize } from "./label";
import type { LocationMatrix } from "./location-matrix";

/** Bin labels (owner, 2026-11-05: "one label is the location code like A2 B3 … the other label has contents", "like 2 gang switches"). */

const matrix: LocationMatrix = {
  racks: [
    { id: "ra", name: "a", shelves: 2, bins: 3 },
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
  it("the code is the owner's: A2 B3 for rack A, shelf 2, bin 3 — a rack named in words keeps its name", () => {
    expect(binCode(rackA, 2, 3)).toBe("A2 B3");
    expect(binCode({ name: "c" }, 12, 40)).toBe("C12 B40");
    expect(binCode(bay, 1, 2)).toBe("Cable bay S1 B2");
  });

  it("a bin gets its code label and its contents label; Code only / Contents only give one", () => {
    const both = binLabels(matrix, rackA, 2, 3, "both");
    expect(both.map((l) => l.kind)).toEqual(["code", "contents"]);
    expect(both[1]).toMatchObject({ code: "A2 B3", place: "Rack A · Shelf 2 · Bin 3", contents: ["2 gang switches", "iconic dimmer"] });
    expect(binLabels(matrix, rackA, 2, 3, "code").map((l) => l.kind)).toEqual(["code"]);
    expect(binLabels(matrix, rackA, 2, 3, "contents").map((l) => l.kind)).toEqual(["contents"]);
  });

  it("a bin with nothing set gets its code label only — never an empty contents label", () => {
    expect(binLabels(matrix, rackA, 1, 1, "both").map((l) => l.kind)).toEqual(["code"]);
    expect(binLabels(matrix, rackA, 1, 1, "contents")).toEqual([]);
  });

  it("a rack's labels come shelf by shelf, bin by bin, the way they sit", () => {
    const all = rackLabels(matrix, rackA, "both");
    expect(all.map((l) => `${l.code} ${l.kind}`)).toEqual([
      "A1 B1 code", "A1 B2 code", "A1 B3 code",
      "A2 B1 code", "A2 B2 code", "A2 B3 code", "A2 B3 contents",
    ]);
    expect(rackLabels(matrix, rackA, "contents")).toHaveLength(1);
    expect(rackLabels(matrix, bay, "both")).toHaveLength(3);
  });

  it("every label size, both kinds, as printed on a B1 (48 mm head): all text inside the label", () => {
    const long = { kind: "contents" as const, code: "Cable bay S12 B40", place: "Cable bay · Shelf 12 · Bin 40", contents: ["2 gang switches", "iconic dimmer", "clipsal 2000 series 4 gang light switch plate"] };
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
    const lay = layoutBinLabel(fitToPrinthead(labelSize("50x30"), 384, "top"), binLabels(matrix, rackA, 2, 3, "code")[0]!);
    expect(lay.width).toBe(384);
    expect(lay.lines.map((l) => l.text)).toEqual(["A2 B3", "Rack A · Shelf 2 · Bin 3"]);
    expect(lay.lines[0]!.size).toBeGreaterThan(lay.height * 0.6);
    expect(lay.lines[0]!.bold).toBe(true);
  });

  it("the contents label: the code on top, then each thing on its own line, smaller than the code and centred", () => {
    const lay = layoutBinLabel(labelSize("40x30"), { kind: "contents", code: "A2 B3", place: "", contents: ["2 gang switches", "iconic dimmer"] });
    expect(lay.lines.map((l) => l.text)).toEqual(["A2 B3", "2 gang switches", "iconic dimmer"]);
    const [code, ...body] = lay.lines;
    expect(code!.bold).toBe(true);
    for (const l of body) expect(l.size).toBeLessThan(code!.size);
    // centred: as much white above the code as below the last line, give or take a dot or two
    const below = lay.height - (body.at(-1)!.y + body.at(-1)!.size);
    expect(Math.abs(code!.y - below)).toBeLessThanOrEqual(2);
  });

  it("more than fits: the list runs on at the smallest size and is cut with …, never past the label's edge", () => {
    const many = Array.from({ length: 12 }, (_, i) => `clipsal iconic 2000 series part ${i + 1}`);
    const lay = layoutBinLabel(labelSize("40x12"), { kind: "contents", code: "A2 B3", place: "", contents: many });
    expect(lay.lines.at(-1)!.text.endsWith("…")).toBe(true);
    for (const l of lay.lines) expect(l.y + l.size).toBeLessThanOrEqual(lay.height);
  });
});
