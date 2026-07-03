/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * A tiny, dependency-free QR code generator (#303) — enough to encode a short
 * ASCII URL into a scannable QR and render it as an SVG path. Pure functions,
 * no I/O, no React, no npm dependency (the repo prefers not adding a QR lib for
 * one print view; this is a few hundred lines of well-understood spec code).
 *
 * Scope (deliberately minimal, matched to the job):
 *   - Byte mode only (our payload is an ASCII URL).
 *   - Error-correction level M (~15% — the print-sheet sweet spot: robust to a
 *     scuffed sticker without ballooning the module count).
 *   - Auto-picks the smallest version (1–10, up to 271 bytes at level M) that
 *     fits the payload. A `/phil/gear/scan?asset=<id>` URL is well under that.
 *   - Mask pattern 0 (a fixed mask keeps this small; every reader handles any
 *     mask — the penalty-optimised choice only matters at the margins).
 *
 * This is intentionally NOT a general QR library. It encodes exactly what the
 * label sheet needs and nothing else. The `!` non-null assertions below are on
 * indexed reads whose bounds the surrounding loops guarantee — the file runs
 * under `noUncheckedIndexedAccess` and the round-trip test proves correctness.
 *
 * Reference: ISO/IEC 18004 (QR Code).
 */

/* ------------------------------------------------------------------ *
 * Galois field GF(256) for Reed–Solomon error correction.
 * ------------------------------------------------------------------ */
const GF_EXP: number[] = new Array(512).fill(0);
const GF_LOG: number[] = new Array(256).fill(0);
(function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // primitive polynomial
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/** Reed–Solomon generator polynomial of the given degree. */
function rsGeneratorPoly(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next: number[] = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] = next[j]! ^ poly[j]!;
      next[j + 1] = next[j + 1]! ^ gfMul(poly[j]!, GF_EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

/** Reed–Solomon EC codewords for a data block. */
function rsEncode(data: number[], ecCount: number): number[] {
  const gen = rsGeneratorPoly(ecCount);
  const res: number[] = new Array(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0]!;
    res.shift();
    res.push(0);
    for (let i = 0; i < gen.length - 1; i++) {
      res[i] = res[i]! ^ gfMul(gen[i + 1]!, factor);
    }
  }
  return res;
}

/* ------------------------------------------------------------------ *
 * Version tables (level M, byte mode) for versions 1–10.
 * ------------------------------------------------------------------ */
interface VersionSpec {
  version: number;
  totalDataCodewords: number;
  ecPerBlock: number;
  blocks: number; // total EC blocks
}

// [version, totalDataCodewords, ecPerBlock, totalBlocks] — level M.
const VERSION_TABLE: VersionSpec[] = [
  { version: 1, totalDataCodewords: 16, ecPerBlock: 10, blocks: 1 },
  { version: 2, totalDataCodewords: 28, ecPerBlock: 16, blocks: 1 },
  { version: 3, totalDataCodewords: 44, ecPerBlock: 26, blocks: 1 },
  { version: 4, totalDataCodewords: 64, ecPerBlock: 18, blocks: 2 },
  { version: 5, totalDataCodewords: 86, ecPerBlock: 24, blocks: 2 },
  { version: 6, totalDataCodewords: 108, ecPerBlock: 16, blocks: 4 },
  { version: 7, totalDataCodewords: 124, ecPerBlock: 18, blocks: 4 },
  { version: 8, totalDataCodewords: 154, ecPerBlock: 22, blocks: 4 },
  { version: 9, totalDataCodewords: 182, ecPerBlock: 22, blocks: 5 },
  { version: 10, totalDataCodewords: 216, ecPerBlock: 26, blocks: 5 },
];

/** Alignment-pattern centre coordinates per version (2..10). Version 1 has none. */
const ALIGNMENT_POSITIONS: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

/* ------------------------------------------------------------------ *
 * Bit buffer.
 * ------------------------------------------------------------------ */
class BitBuffer {
  bits: number[] = [];
  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      this.bits.push((value >>> i) & 1);
    }
  }
  get length(): number {
    return this.bits.length;
  }
}

/** Encode a payload into data codewords for a chosen version. */
function encodeData(bytes: number[], spec: VersionSpec): number[] {
  const buf = new BitBuffer();
  // Mode indicator: byte mode = 0100.
  buf.put(0b0100, 4);
  // Character-count indicator: 8 bits for versions 1–9, 16 for 10+.
  buf.put(bytes.length, spec.version >= 10 ? 16 : 8);
  for (const b of bytes) buf.put(b, 8);

  const capacityBits = spec.totalDataCodewords * 8;
  // Terminator (up to 4 zero bits).
  const remaining = capacityBits - buf.length;
  buf.put(0, Math.min(4, Math.max(0, remaining)));
  // Pad to a byte boundary.
  while (buf.length % 8 !== 0) buf.bits.push(0);
  // Fill remaining codewords with the alternating pad bytes.
  const padBytes = [0xec, 0x11];
  let pad = 0;
  while (buf.length < capacityBits) {
    buf.put(padBytes[pad % 2]!, 8);
    pad++;
  }

  // Pack bits into codewords.
  const codewords: number[] = [];
  for (let i = 0; i < buf.length; i += 8) {
    let cw = 0;
    for (let j = 0; j < 8; j++) cw = (cw << 1) | buf.bits[i + j]!;
    codewords.push(cw);
  }
  return codewords;
}

/** Interleave data + EC codewords across all blocks per the QR standard. */
function buildFinalCodewords(dataCodewords: number[], spec: VersionSpec): number[] {
  const totalBlocks = spec.blocks;
  const shortLen = Math.floor(spec.totalDataCodewords / totalBlocks);
  const longBlocks = spec.totalDataCodewords % totalBlocks; // blocks with +1 codeword
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];

  let offset = 0;
  for (let b = 0; b < totalBlocks; b++) {
    const len = shortLen + (b >= totalBlocks - longBlocks ? 1 : 0);
    const block = dataCodewords.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, spec.ecPerBlock));
  }

  const result: number[] = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]!);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const block of ecBlocks) result.push(block[i]!);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Matrix construction.
 * ------------------------------------------------------------------ */
interface Cell {
  dark: boolean;
  reserved: boolean;
}

function makeMatrix(size: number): Cell[][] {
  return Array.from({ length: size }, () =>
    Array.from({ length: size }, () => ({ dark: false, reserved: false })),
  );
}

function setCell(m: Cell[][], r: number, c: number, dark: boolean, reserved = true): void {
  const row = m[r];
  if (!row) return;
  if (c < 0 || c >= row.length) return;
  row[c] = { dark, reserved };
}

function cellAt(m: Cell[][], r: number, c: number): Cell | undefined {
  return m[r]?.[c];
}

function placeFinder(m: Cell[][], row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      const dark =
        (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
        (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
        (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      setCell(m, rr, cc, dark);
    }
  }
}

function placeAlignment(m: Cell[][], version: number): void {
  const positions = ALIGNMENT_POSITIONS[version] ?? [];
  const last = positions[positions.length - 1];
  for (const r of positions) {
    for (const c of positions) {
      // Skip the three that collide with finder patterns.
      if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setCell(m, r + dr, c + dc, dark);
        }
      }
    }
  }
}

function placeTiming(m: Cell[][]): void {
  const size = m.length;
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    if (!cellAt(m, 6, i)?.reserved) setCell(m, 6, i, dark);
    if (!cellAt(m, i, 6)?.reserved) setCell(m, i, 6, dark);
  }
}

function reserveFormatAreas(m: Cell[][], version: number): void {
  const size = m.length;
  const reserve = (r: number, c: number) => {
    const cell = cellAt(m, r, c);
    if (cell && !cell.reserved) cell.reserved = true;
  };
  // Format info around the top-left finder + mirrored strips.
  for (let i = 0; i < 9; i++) {
    reserve(8, i);
    reserve(i, 8);
  }
  for (let i = 0; i < 8; i++) {
    reserve(8, size - 1 - i);
    reserve(size - 1 - i, 8);
  }
  // Dark module (always set).
  setCell(m, size - 8, 8, true);
  // Version info (versions 7+).
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        reserve(i, size - 11 + j);
        reserve(size - 11 + j, i);
      }
    }
  }
}

/** Place data bits in the zig-zag column pattern, applying mask 0. */
function placeData(m: Cell[][], codewords: number[]): void {
  const size = m.length;
  const bits: number[] = [];
  for (const cw of codewords) {
    for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);
  }
  let bitIndex = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip the vertical timing column
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        const cell = cellAt(m, row, cc);
        if (!cell || cell.reserved) continue;
        let dark = bitIndex < bits.length ? bits[bitIndex] === 1 : false;
        bitIndex++;
        // Mask pattern 0: invert where (row + col) % 2 === 0.
        if ((row + cc) % 2 === 0) dark = !dark;
        setCell(m, row, cc, dark);
      }
    }
    upward = !upward;
  }
}

/** Format-info bits for level M + mask 0 (BCH-computed, XOR-masked). */
function placeFormatInfo(m: Cell[][]): void {
  const size = m.length;
  // (M=00, mask 0=000) → BCH remainder 0 → the canonical XOR mask itself.
  const formatBits = 0b101010000010010;
  const bit = (i: number) => (formatBits >>> i) & 1;

  // Around the top-left finder.
  for (let i = 0; i <= 5; i++) setCell(m, 8, i, bit(i) === 1);
  setCell(m, 8, 7, bit(6) === 1);
  setCell(m, 8, 8, bit(7) === 1);
  setCell(m, 7, 8, bit(8) === 1);
  for (let i = 9; i <= 14; i++) setCell(m, 14 - i, 8, bit(i) === 1);

  // The split copy along the right + bottom strips.
  for (let i = 0; i <= 7; i++) setCell(m, size - 1 - i, 8, bit(i) === 1);
  for (let i = 8; i <= 14; i++) setCell(m, 8, size - 15 + i, bit(i) === 1);
}

export interface QrMatrix {
  size: number;
  /** row-major booleans; true = dark module. */
  modules: boolean[][];
  version: number;
}

/**
 * Build a QR matrix for an ASCII payload. Throws if the payload exceeds our
 * version-10 level-M byte capacity (271 bytes) — far beyond any scan URL.
 */
export function encodeQr(text: string): QrMatrix {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) {
      // Non-ASCII would need UTF-8 multibyte; our URLs are ASCII by construction.
      throw new Error("qr: only ASCII payloads are supported");
    }
    bytes.push(code);
  }

  const spec = VERSION_TABLE.find((v) => {
    const countBits = v.version >= 10 ? 16 : 8;
    const neededBits = 4 + countBits + bytes.length * 8;
    return neededBits <= v.totalDataCodewords * 8;
  });
  if (!spec) {
    throw new Error("qr: payload too long for supported versions (max ~271 bytes)");
  }

  const size = 17 + spec.version * 4;
  const m = makeMatrix(size);
  placeFinder(m, 0, 0);
  placeFinder(m, 0, size - 7);
  placeFinder(m, size - 7, 0);
  placeAlignment(m, spec.version);
  placeTiming(m);
  reserveFormatAreas(m, spec.version);

  const dataCodewords = encodeData(bytes, spec);
  const finalCodewords = buildFinalCodewords(dataCodewords, spec);
  placeData(m, finalCodewords);
  placeFormatInfo(m);

  return {
    size,
    version: spec.version,
    modules: m.map((row) => row.map((cell) => cell.dark)),
  };
}

/**
 * Render a QR matrix as a compact SVG string. A quiet zone of `margin` modules
 * is added around the code (4 is the spec minimum for reliable scanning). A
 * single `<path>` of dark modules keeps the markup small.
 */
export function qrToSvg(
  matrix: QrMatrix,
  opts: { size?: number; margin?: number; className?: string } = {},
): string {
  const margin = opts.margin ?? 4;
  const dim = matrix.size + margin * 2;
  const parts: string[] = [];
  for (let r = 0; r < matrix.size; r++) {
    const row = matrix.modules[r]!;
    for (let c = 0; c < matrix.size; c++) {
      if (row[c]) parts.push(`M${c + margin} ${r + margin}h1v1h-1z`);
    }
  }
  const sizeAttr = opts.size ? ` width="${opts.size}" height="${opts.size}"` : "";
  const classAttr = opts.className ? ` class="${opts.className}"` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}"` +
    sizeAttr +
    classAttr +
    ` shape-rendering="crispEdges" role="img">` +
    `<rect width="${dim}" height="${dim}" fill="#ffffff"/>` +
    `<path d="${parts.join("")}" fill="#000000"/>` +
    `</svg>`
  );
}
