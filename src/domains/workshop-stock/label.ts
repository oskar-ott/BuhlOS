/**
 * Barcode labels for a NIIMBOT label printer (owner, 2026-11-03: "i have a
 * niimbot printer i want to be able to create barcodes for items if there's no
 * packaging easily"). Pure: the EAN-13 bar pattern and the label layout; the
 * component draws them on a canvas and hands the image to the NIIMBOT app.
 *
 * NIIMBOT printers print at 203 dpi = 8 dots per mm, so a label is drawn at
 * 8 px/mm and every bar is a whole number of dots (no blurry edges, scans first
 * time).
 */

export const DOTS_PER_MM = 8;

export interface LabelSize {
  key: string;
  label: string;
  /** along the label (the printer's feed is the other way — the NIIMBOT app rotates as needed) */
  widthMm: number;
  heightMm: number;
  /** which NIIMBOT printers take this label: D11/D110 ("D") or B1/B21 ("B") */
  family: "D" | "B";
}

export const LABEL_SIZES: readonly LabelSize[] = [
  { key: "40x12", label: "40 × 12 mm (D11, D110)", widthMm: 40, heightMm: 12, family: "D" },
  { key: "30x15", label: "30 × 15 mm (D11, D110)", widthMm: 30, heightMm: 15, family: "D" },
  { key: "40x30", label: "40 × 30 mm (B1, B21)", widthMm: 40, heightMm: 30, family: "B" },
  { key: "50x30", label: "50 × 30 mm (B1, B21)", widthMm: 50, heightMm: 30, family: "B" },
];

export function labelSize(key: string | null | undefined): LabelSize {
  return LABEL_SIZES.find((s) => s.key === key) ?? LABEL_SIZES[0]!;
}

/**
 * The label as the printer can actually print it. A print head is a fixed
 * number of dots across (the B1's is 384 = 48 mm), and a label can be wider
 * than that (50 mm on the B1): the across side is cut to the head, so the
 * layout is drawn to fit it rather than clipped at the edges. "top" printers
 * (B1, B21) take the label upright, its width across the head; "left" ones
 * (D11, D110) take it on its side, its height across the head.
 */
export function fitToPrinthead(size: LabelSize, printheadPixels: number, direction: "top" | "left"): LabelSize {
  const headMm = Math.floor(printheadPixels / DOTS_PER_MM);
  if (!(headMm > 0)) return size;
  return direction === "left"
    ? { ...size, heightMm: Math.min(size.heightMm, headMm) }
    : { ...size, widthMm: Math.min(size.widthMm, headMm) };
}

/** "D" / "B" for a NIIMBOT model name ("B1", "D110_M"), null for one we don't size labels for. */
export function printerFamily(model: string | null | undefined): "D" | "B" | null {
  if (!model) return null;
  if (/^D(11|110|101)(_|S|$)/.test(model)) return "D";
  if (/^B(1|21)(_|S|$)/.test(model)) return "B";
  return null;
}

const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

/** True when the 13 digits carry a correct EAN-13 check digit. */
export function ean13Valid(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(code[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}

/**
 * The 95 modules of an EAN-13 ("1" = bar, "0" = space): start guard, six
 * left digits (L/G by the first digit), centre guard, six right digits (R),
 * end guard. Null for anything that isn't a valid EAN-13.
 */
export function ean13Modules(code: string): string | null {
  if (!ean13Valid(code)) return null;
  const d = [...code].map(Number);
  const parity = PARITY[d[0]!]!;
  let out = "101";
  for (let i = 1; i <= 6; i++) out += (parity[i - 1] === "L" ? L : G)[d[i]!]!;
  out += "01010";
  for (let i = 7; i <= 12; i++) out += R[d[i]!]!;
  out += "101";
  return out;
}

/** Guard bars (start, centre, end) are drawn a little longer, as on a shop barcode. */
export function isGuardModule(index: number): boolean {
  return index < 3 || (index >= 45 && index < 50) || index >= 92;
}

export interface LabelLayout {
  width: number;
  height: number;
  /** dots per bar module */
  module: number;
  barsX: number;
  barsY: number;
  barsHeight: number;
  /** the item's name, cut to what fits (1–2 lines) */
  nameLines: string[];
  nameSize: number;
  /** the shelf / bin, when there's room */
  shelf: string | null;
  digitsSize: number;
}

/** Cut text into at most `maxLines` lines of about `perLine` characters, on word breaks. */
export function wrapText(text: string, perLine: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= perLine) { cur = next; continue; }
    if (cur) lines.push(cur);
    cur = w.length > perLine ? w.slice(0, perLine) : w;
    if (lines.length === maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    const last = lines[maxLines - 1]!;
    lines[maxLines - 1] = last.length >= perLine ? `${last.slice(0, perLine - 1)}…` : `${last}…`;
  }
  return lines;
}

/**
 * Where everything goes on a label of this size: the bars as wide as fit in
 * whole dots (at least 2 per module, so a cheap scanner reads it), the name
 * above, the digits under the bars, the shelf when the label is tall enough.
 */
export function layoutLabel(size: LabelSize, name: string, shelf: string | null): LabelLayout {
  const width = size.widthMm * DOTS_PER_MM;
  const height = size.heightMm * DOTS_PER_MM;
  const quiet = 9; // modules of white each side (EAN-13 wants 11/7; the label edge adds the rest)
  const dots = Math.max(2, Math.floor((width - 8) / (95 + quiet * 2)));
  const barsWidth = 95 * dots;
  const barsX = Math.round((width - barsWidth) / 2);
  const tall = size.heightMm >= 25;
  const nameSize = tall ? 26 : 15;
  const digitsSize = tall ? 20 : 12;
  const nameLines = wrapText(name, Math.floor(width / (nameSize * 0.55)), tall ? 2 : 1);
  const shelfLine = tall && shelf ? shelf : null;
  const top = 4 + nameLines.length * (nameSize + 2) + (shelfLine ? digitsSize + 4 : 0) + 2;
  const barsHeight = Math.max(24, height - top - digitsSize - 6);
  return { width, height, module: dots, barsX, barsY: top, barsHeight, nameLines, nameSize, shelf: shelfLine, digitsSize };
}
