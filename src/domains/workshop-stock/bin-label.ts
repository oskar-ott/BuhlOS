import { DOTS_PER_MM, wrapText, type LabelSize } from "./label";
import { binsOn, rackLabel, rulesInBin, shelfLabel, type LocationMatrix, type MatrixRack } from "./location-matrix";

/**
 * Labels for the bins (owner, 2026-11-05: "print labels for the bins … one
 * label is the location code like A2 B3 for rack a shelve 2 bin 3 … and the
 * other label has contents"). Pure: which labels a bin or rack gets, and where
 * the text goes. Printed on the same NIIMBOT connection as item labels.
 *
 * - the **code** label: the bin's short code, as large as the label allows;
 * - the **contents** label: the code small at the top, then what goes in the
 *   bin — the location matrix's words for it ("iconic switch"). The matrix
 *   words, not today's stock: a printed label can't follow stock as it moves,
 *   the words are what the office set for the bin.
 *
 * Words only — no barcode (the owner's pick). The code is display only: items
 * keep their stored location text ("Rack 3 Shelf B, Bin 4").
 *
 * The code follows the workshop's naming — racks numbered, shelves lettered,
 * bins numbered (owner correction in #1128): "3B-4" is rack 3, shelf B, bin 4
 * (owner's pick, 2026-11-05, over keeping "A2 B3" literally).
 */

export type BinLabelKind = "code" | "contents";

/**
 * Which of a bin's labels to print — each one picked on its own (owner,
 * 2026-11-06: "i want to be able to pick which labels not have 2 labels
 * printed for each bin").
 */
export type BinLabelPick = Readonly<Record<BinLabelKind, boolean>>;

export const BIN_LABEL_NAMES: Readonly<Record<BinLabelKind, string>> = { code: "Code label", contents: "Contents label" };

/**
 * "3B-4" for rack 3, shelf B, bin 4. A rack named in words keeps its name:
 * "Cable bay B-4".
 */
export function binCode(rack: Pick<MatrixRack, "name">, shelf: number, bin: number): string {
  const name = rack.name.trim();
  const place = `${shelfLabel(shelf)}-${bin}`;
  return /^[A-Za-z0-9]{1,3}$/.test(name) ? `${name.toUpperCase()}${place}` : `${name} ${place}`;
}

export interface BinLabelSpec {
  kind: BinLabelKind;
  /** "3B-4" */
  code: string;
  /** "Rack 3 · Shelf B · Bin 4" — the place in words, under the code on a tall label */
  place: string;
  /** the matrix words for the bin, in the order they were added */
  contents: string[];
}

/**
 * Every label a bin can have: its code label, and its contents label when it
 * has words (a bin with nothing set has nothing to say on one).
 */
export function binLabels(matrix: LocationMatrix, rack: MatrixRack, shelf: number, bin: number): BinLabelSpec[] {
  const code = binCode(rack, shelf, bin);
  const place = `${rackLabel(rack.name)} · Shelf ${shelfLabel(shelf)} · Bin ${bin}`;
  const contents = rulesInBin(matrix, rack.id, shelf, bin).map((r) => r.words.trim()).filter(Boolean);
  const out: BinLabelSpec[] = [{ kind: "code", code, place, contents }];
  if (contents.length) out.push({ kind: "contents", code, place, contents });
  return out;
}

/** The labels picked to print. */
export function pickedLabels(specs: BinLabelSpec[], pick: BinLabelPick): BinLabelSpec[] {
  return specs.filter((s) => pick[s.kind]);
}

/** A rack's picked labels, shelf by shelf, bin by bin — the order they sit in. */
export function rackLabels(matrix: LocationMatrix, rack: MatrixRack, pick: BinLabelPick): BinLabelSpec[] {
  const out: BinLabelSpec[] = [];
  for (let shelf = 1; shelf <= rack.shelves; shelf++) {
    for (let bin = 1; bin <= binsOn(rack, shelf); bin++) out.push(...pickedLabels(binLabels(matrix, rack, shelf, bin), pick));
  }
  return out;
}

export interface TextLine {
  text: string;
  /** font size in dots — the largest it may be; drawing shrinks it to fit the width */
  size: number;
  bold: boolean;
  /** top of the line, in dots */
  y: number;
}

export interface BinLabelLayout {
  width: number;
  height: number;
  lines: TextLine[];
}

/** Where the text goes on a label of this size (already fitted to the printer's head). */
export function layoutBinLabel(size: LabelSize, spec: BinLabelSpec): BinLabelLayout {
  const width = size.widthMm * DOTS_PER_MM;
  const height = size.heightMm * DOTS_PER_MM;
  const tall = size.heightMm >= 25;
  const lines: TextLine[] = [];
  if (spec.kind === "code") {
    // the code as large as the label allows; on a tall label, the place in words under it
    const placeSize = tall ? Math.round(height * 0.11) : 0;
    const codeSize = Math.round((height - placeSize - (tall ? 16 : 8)) * 0.92);
    const top = Math.round((height - codeSize - (placeSize ? placeSize + 6 : 0)) / 2);
    lines.push({ text: spec.code, size: codeSize, bold: true, y: top });
    if (placeSize) lines.push({ text: spec.place, size: placeSize, bold: false, y: top + codeSize + 6 });
    return { width, height, lines };
  }
  // contents: the code on top, then what goes in it, smaller than the code and
  // as large as lets all of it fit — each thing whole on its own line where
  // that costs little size, else wrapped; when nothing fits, the list runs on
  // and is cut with … at the smallest size
  const codeSize = Math.round(height * (tall ? 0.2 : 0.34));
  const room = height - codeSize - 6 - 8;
  const largest = Math.min(Math.round(height * (tall ? 0.2 : 0.27)), Math.floor(codeSize * 0.8));
  const linesAt = (size: number, whole: boolean): string[] | null => {
    const maxLines = Math.max(1, Math.floor((room + 4) / (size + 4)));
    const perLine = Math.max(6, Math.floor((width - 12) / (size * 0.55)));
    const out = spec.contents.flatMap((item) => wrapText(item, perLine, whole ? 1 : maxLines));
    return out.length <= maxLines && !out.some((l) => l.endsWith("…")) ? out : null;
  };
  const largestFit = (whole: boolean) => {
    for (let size = largest; size >= 12; size--) {
      const out = linesAt(size, whole);
      if (out) return { size, body: out };
    }
    return null;
  };
  const wrapped = largestFit(false);
  const whole = largestFit(true);
  const pick = whole && (!wrapped || whole.size >= wrapped.size * 0.85) ? whole : wrapped;
  const textSize = pick?.size ?? 12;
  const body = pick?.body ?? wrapText(spec.contents.join(", "), Math.floor((width - 12) / (12 * 0.55)), Math.max(1, Math.floor((room + 4) / 16)));
  const blockHeight = codeSize + 6 + body.length * (textSize + 4) - 4;
  const top = Math.max(4, Math.round((height - blockHeight) / 2));
  lines.push({ text: spec.code, size: codeSize, bold: true, y: top });
  body.forEach((line, i) => lines.push({ text: line, size: textSize, bold: false, y: top + codeSize + 6 + i * (textSize + 4) }));
  return { width, height, lines };
}
