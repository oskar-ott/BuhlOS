import { describe, expect, it } from "vitest";
import { encodeQr, qrToSvg, type QrMatrix } from "./qr";
import { assetScanUrl } from "./scan-url";

/**
 * The QR generator has no external reference in this repo, so these tests prove
 * correctness structurally + by a round-trip that REVERSES the encoder's data
 * placement and mask to recover the original codeword stream. If placement or
 * masking were wrong, the recovered bytes wouldn't reconstruct the payload's
 * mode/length header — so this catches the failure that matters (an unscannable
 * code) without needing a camera.
 */

/** Re-derive the version spec + reserved map the encoder used, then walk the
 *  data region in the SAME zig-zag order, un-applying mask 0, to recover the
 *  data codewords. We only need enough to read the byte-mode header + payload. */
function recoverPayload(matrix: QrMatrix): string {
  const size = matrix.size;
  // Rebuild the "reserved" map: everything that is a function pattern. We mark
  // finders (+separators), timing, alignment, format/version — matching the
  // encoder — so the walk visits exactly the data cells in the same order.
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (r: number, c: number) => {
    if (r >= 0 && c >= 0 && r < size && c < size) reserved[r]![c] = true;
  };
  const markFinder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) mark(row + r, col + c);
  };
  markFinder(0, 0);
  markFinder(0, size - 7);
  markFinder(size - 7, 0);
  // Timing.
  for (let i = 0; i < size; i++) {
    mark(6, i);
    mark(i, 6);
  }
  // Alignment (versions 2+). Mirror the encoder's positions for v1..v10.
  const ALIGN: Record<number, number[]> = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };
  const positions = ALIGN[matrix.version] || [];
  for (const r of positions) {
    for (const c of positions) {
      if (
        (r === 6 && c === 6) ||
        (r === 6 && c === positions[positions.length - 1]) ||
        (r === positions[positions.length - 1] && c === 6)
      ) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
    }
  }
  // Format areas.
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }
  mark(size - 8, 8);
  if (matrix.version >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
      mark(i, size - 11 + j);
      mark(size - 11 + j, i);
    }
  }

  // Walk the data region, un-masking (mask 0: invert where (r+c)%2===0), and
  // pack back into the interleaved codeword stream.
  const bits: number[] = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (reserved[row]![cc]) continue;
        let dark = matrix.modules[row]![cc]!;
        if ((row + cc) % 2 === 0) dark = !dark;
        bits.push(dark ? 1 : 0);
      }
    }
    upward = !upward;
  }
  const interleaved: number[] = [];
  for (let i = 0; i + 7 < bits.length; i += 8) {
    let cw = 0;
    for (let j = 0; j < 8; j++) cw = (cw << 1) | bits[i + j]!;
    interleaved.push(cw);
  }

  // De-interleave the data codewords (mirror buildFinalCodewords). We only need
  // the DATA blocks (EC codewords are the tail; we drop them). Level-M specs:
  const SPECS: Record<number, { totalData: number; blocks: number }> = {
    1: { totalData: 16, blocks: 1 }, 2: { totalData: 28, blocks: 1 },
    3: { totalData: 44, blocks: 1 }, 4: { totalData: 64, blocks: 2 },
    5: { totalData: 86, blocks: 2 }, 6: { totalData: 108, blocks: 4 },
    7: { totalData: 124, blocks: 4 }, 8: { totalData: 154, blocks: 4 },
    9: { totalData: 182, blocks: 5 }, 10: { totalData: 216, blocks: 5 },
  };
  const spec = SPECS[matrix.version]!;
  const totalBlocks = spec.blocks;
  const shortLen = Math.floor(spec.totalData / totalBlocks);
  const longBlocks = spec.totalData % totalBlocks;
  const blockLens = Array.from({ length: totalBlocks }, (_, b) =>
    shortLen + (b >= totalBlocks - longBlocks ? 1 : 0),
  );
  const dataBlocks: number[][] = blockLens.map(() => []);
  const maxLen = Math.max(...blockLens);
  let idx = 0;
  for (let i = 0; i < maxLen; i++) {
    for (let b = 0; b < totalBlocks; b++) {
      if (i < blockLens[b]!) dataBlocks[b]!.push(interleaved[idx++]!);
    }
  }
  const dataCodewords: number[] = dataBlocks.flat();

  // Parse the byte-mode header from the recovered data bitstream.
  const dataBits: number[] = [];
  for (const cw of dataCodewords) for (let i = 7; i >= 0; i--) dataBits.push((cw >>> i) & 1);
  let p = 0;
  const take = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | dataBits[p++]!;
    return v;
  };
  const mode = take(4);
  expect(mode).toBe(0b0100); // byte mode
  const count = take(matrix.version >= 10 ? 16 : 8);
  let out = "";
  for (let i = 0; i < count; i++) out += String.fromCharCode(take(8));
  return out;
}

describe("qr — tiny dependency-free generator (#303)", () => {
  it("round-trips a scan URL payload through encode → placement → recover", () => {
    const url = "https://app.example.com/phil/gear/scan?asset=a_kd93jf";
    const m = encodeQr(url);
    expect(recoverPayload(m)).toBe(url);
  });

  it("round-trips a short and a longer payload (version auto-scales)", () => {
    const short = "a";
    const long = "https://app.buhlos.example.com/phil/gear/scan?asset=" + "x".repeat(80);
    expect(recoverPayload(encodeQr(short))).toBe(short);
    const mLong = encodeQr(long);
    expect(recoverPayload(mLong)).toBe(long);
    // The longer payload must have chosen a higher version than the short one.
    expect(mLong.version).toBeGreaterThan(encodeQr(short).version);
  });

  it("places the three finder patterns (7×7 dark ring, light centre gap)", () => {
    const m = encodeQr("https://app.example.com/phil/gear/scan?asset=a_1");
    const finderDarkCorner = (row: number, col: number) => {
      // top-left module of a finder is dark; the (1,1) inner ring cell is light.
      expect(m.modules[row]![col]).toBe(true);
      expect(m.modules[row + 1]![col + 1]).toBe(false);
      // 3×3 centre is dark.
      expect(m.modules[row + 3]![col + 3]).toBe(true);
    };
    finderDarkCorner(0, 0);
    finderDarkCorner(0, m.size - 7);
    finderDarkCorner(m.size - 7, 0);
  });

  it("size follows the version formula (17 + 4·version)", () => {
    const m = encodeQr("a");
    expect(m.size).toBe(17 + m.version * 4);
  });

  it("rejects a non-ASCII payload (URLs are ASCII by construction)", () => {
    expect(() => encodeQr("emoji \u{1F600}")).toThrow(/ASCII/);
  });

  it("renders an SVG with a quiet zone and a single dark path", () => {
    const svg = qrToSvg(encodeQr("a_1"), { margin: 4 });
    expect(svg).toContain("<svg");
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('fill="#000000"');
    // viewBox includes the 4-module quiet zone on each side.
    const m = encodeQr("a_1");
    expect(svg).toContain(`viewBox="0 0 ${m.size + 8} ${m.size + 8}"`);
  });

  it("end-to-end: a printed label's QR round-trips back to the exact scan URL", () => {
    // This is the sticker→scan contract: what the label sheet encodes is exactly
    // what the scan landing page will receive.
    const url = assetScanUrl("https://app.example.com", "a_kd93jf");
    expect(recoverPayload(encodeQr(url))).toBe(url);
  });
});
