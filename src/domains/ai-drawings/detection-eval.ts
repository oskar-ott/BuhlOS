// Epic 5 (#204) — detection evaluation: per-label precision/recall against a
// hand-labelled reference sheet.
//
// The issue gates every prompt/model change on measured P/R — this module is
// the scorer. It is pure and deliberately boring: greedy IoU matching per
// label, no partial credit, label confusion counts as BOTH a false positive
// (the wrong label) and a false negative (the missed right one). The
// reference format is the checked-in contract a human labeller produces.

import type { CropRegion } from "./schema";

/** One box in either the detections or the reference. */
export interface EvalBox {
  label: string;
  bbox: CropRegion;
}

export interface LabelScore {
  tp: number;
  fp: number;
  fn: number;
  precision: number | null; // null when undefined (no positives predicted)
  recall: number | null; // null when undefined (no reference instances)
  f1: number | null;
}

export interface EvalResult {
  iouThreshold: number;
  perLabel: Record<string, LabelScore>;
  overall: LabelScore;
}

export function boxIoU(a: CropRegion, b: CropRegion): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.w * a.h + b.w * b.h - inter;
  // clamp — float error can push identical boxes a hair over 1
  return union > 0 ? Math.min(1, Math.max(0, inter / union)) : 0;
}

function score(tp: number, fp: number, fn: number): LabelScore {
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;
  return { tp, fp, fn, precision, recall, f1 };
}

/**
 * Greedy IoU matching per label: repeatedly pair the highest-IoU
 * (detection, reference) couple above the threshold; unmatched detections
 * are false positives, unmatched reference boxes false negatives.
 */
export function scoreDetections(
  detected: ReadonlyArray<EvalBox>,
  reference: ReadonlyArray<EvalBox>,
  iouThreshold = 0.5,
): EvalResult {
  const labels = new Set<string>([
    ...detected.map((d) => d.label),
    ...reference.map((r) => r.label),
  ]);
  const perLabel: Record<string, LabelScore> = {};
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const label of labels) {
    const dets = detected.filter((d) => d.label === label);
    const refs = reference.filter((r) => r.label === label);
    const usedDet = new Set<number>();
    const usedRef = new Set<number>();
    // greedy: best remaining pair first
    for (;;) {
      let best: { di: number; ri: number; iou: number } | null = null;
      for (let di = 0; di < dets.length; di += 1) {
        if (usedDet.has(di)) continue;
        for (let ri = 0; ri < refs.length; ri += 1) {
          if (usedRef.has(ri)) continue;
          const iou = boxIoU(dets[di]!.bbox, refs[ri]!.bbox);
          if (iou >= iouThreshold && (!best || iou > best.iou)) {
            best = { di, ri, iou };
          }
        }
      }
      if (!best) break;
      usedDet.add(best.di);
      usedRef.add(best.ri);
    }
    const ltp = usedDet.size;
    const lfp = dets.length - ltp;
    const lfn = refs.length - usedRef.size;
    perLabel[label] = score(ltp, lfp, lfn);
    tp += ltp;
    fp += lfp;
    fn += lfn;
  }
  return { iouThreshold, perLabel, overall: score(tp, fp, fn) };
}

/**
 * Reference-sheet file contract (`*.detection-reference.json`) a human
 * labeller produces for a real sheet:
 *   { "planId": "...", "pageIndex": 0, "pageSha256": "...",
 *     "labelledBy": "...", "labelledAt": "ISO",
 *     "boxes": [{ "label": "DOUBLE GPO", "bbox": {x,y,w,h} }] }
 * The scorer consumes `boxes` — everything else is provenance.
 */
export interface DetectionReference {
  planId: string;
  pageIndex: number;
  pageSha256: string;
  labelledBy: string;
  labelledAt: string;
  boxes: EvalBox[];
}
