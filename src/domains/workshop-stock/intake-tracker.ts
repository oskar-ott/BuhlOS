/**
 * Workshop Stock, camera table — finding objects on the table. Pure, no DOM.
 *
 * Runs in the browser on a small copy of each video frame (about 320 px wide, a
 * few times a second), compared with a picture of the empty table. It only says
 * WHERE something new is; reading what it is happens once, on a sharp crop of the
 * full frame. Video never leaves the computer.
 *
 * What it has to get right is counting each placed object once:
 *   • a blob touching the edge of the picture is an arm, not an object — it is
 *     never counted, and anything it covers stays on the table while it does;
 *   • an object must sit still for SETTLE_MS before it counts;
 *   • a nudged object is still the same object (the boxes overlap);
 *   • objects pushed together stay as they were, flagged `touching`, and any
 *     that split off again keep their identity. Only a blob no track claims is new.
 */

/** A rectangle in fractions of the picture (0–1), so it fits any display or crop size. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RawFrame {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

export interface FoundObjects {
  objects: Box[];
  /** blobs touching the edge of the picture: arms, or something half out of shot */
  arms: Box[];
  /** how much of the picture differs from the empty table, 0–1 */
  changedShare: number;
}

const CELL = 4;
const PIXEL_THRESHOLD = 30;
const CELL_ACTIVE_SHARE = 0.35;
const MIN_OBJECT_CELLS = 5;
/** pieces this many cells apart (≈ 2.5% of the width) are one thing */
const MERGE_GAP = 2;
/** coarse regions for the local light correction (a webcam's exposure and the room's light vary across the table) */
const REGION = 40;
/** a smooth light change has no edges; an object brings its own — this many grey levels of edge change counts */
const EDGE_THRESHOLD = 22;

const luma = (d: ArrayLike<number>, i: number) => (d[i]! * 77 + d[i + 1]! * 150 + d[i + 2]! * 29) >> 8;

function median(values: number[]): number {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b);
  return v[v.length >> 1]!;
}

/**
 * How much brighter each part of the picture is than the empty table, as a
 * GAIN (a webcam's auto-exposure scales brightness, it doesn't add to it): the
 * middle ratio in each coarse region, then the middle of each region and its
 * neighbours, so an object covering one region can't pass for a light change.
 * Returns a gain per pixel row/column lookup (bilinear across region centres).
 */
function lightGain(frame: RawFrame, background: ArrayLike<number>): (x: number, y: number) => number {
  const { width, height, data } = frame;
  const rw = Math.max(1, Math.round(width / REGION));
  const rh = Math.max(1, Math.round(height / REGION));
  const raw = new Float32Array(rw * rh);
  for (let ry = 0; ry < rh; ry++) {
    for (let rx = 0; rx < rw; rx++) {
      const ratios: number[] = [];
      const x0 = Math.floor((rx * width) / rw), x1 = Math.floor(((rx + 1) * width) / rw);
      const y0 = Math.floor((ry * height) / rh), y1 = Math.floor(((ry + 1) * height) / rh);
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * width + x) * 4;
          ratios.push((luma(data, i) + 8) / (luma(background, i) + 8));
        }
      }
      raw[ry * rw + rx] = median(ratios) || 1;
    }
  }
  const gain = new Float32Array(rw * rh);
  for (let ry = 0; ry < rh; ry++) {
    for (let rx = 0; rx < rw; rx++) {
      const near: number[] = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = rx + dx, ny = ry + dy;
        if (nx >= 0 && ny >= 0 && nx < rw && ny < rh) near.push(raw[ny * rw + nx]!);
      }
      gain[ry * rw + rx] = median(near);
    }
  }
  return (x, y) => {
    const fx = Math.min(Math.max((x * rw) / width - 0.5, 0), rw - 1);
    const fy = Math.min(Math.max((y * rh) / height - 0.5, 0), rh - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, rw - 1), y1 = Math.min(y0 + 1, rh - 1);
    const tx = fx - x0, ty = fy - y0;
    const top = gain[y0 * rw + x0]! * (1 - tx) + gain[y0 * rw + x1]! * tx;
    const bottom = gain[y1 * rw + x0]! * (1 - tx) + gain[y1 * rw + x1]! * tx;
    return top * (1 - ty) + bottom * ty;
  };
}

/**
 * Compares a frame with the empty table (2026-11-03: on a real webcam the old
 * plain brightness difference boxed the light band, the vignetting and the
 * shadows as dozens of "objects", and missed a white bag on a white table).
 * First the table's light is matched region by region (gain, not offset).
 * Then a pixel differs when its EDGES changed — an object brings an outline
 * and print, a light change is smooth — or its colour changed by a lot. Both
 * thresholds rise with the camera's own noise, measured on this frame. A cell
 * differs when enough of its pixels do; differing cells are joined across
 * one-cell gaps (a white label on a dark box is still one object), and each
 * joined group becomes a box around its cells.
 */
export function findObjects(frame: RawFrame, background: ArrayLike<number>): FoundObjects {
  const { width, height, data } = frame;
  const gw = Math.floor(width / CELL);
  const gh = Math.floor(height / CELL);
  if (gw < 3 || gh < 3) return { objects: [], arms: [], changedShare: 0 };
  const gainAt = lightGain(frame, background);
  const gains = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) gains[y * width + x] = gainAt(x, y);

  // the corrected colour difference, and the change in edges (brightness steps to the right and below)
  const colour = new Float32Array(width * height);
  const edge = new Float32Array(width * height);
  // edges that weren't on the empty table: an object ADDS an outline and print;
  // something taken away since Start (a moved cable) only removes edges — a ghost
  const appeared = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = p * 4;
      const g = gains[p]!;
      colour[p] = Math.max(
        Math.abs(data[i]! - background[i]! * g),
        Math.abs(data[i + 1]! - background[i + 1]! * g),
        Math.abs(data[i + 2]! - background[i + 2]! * g),
      );
      if (x < width - 1 && y < height - 1) {
        const r = i + 4, d = i + width * 4;
        const fe = Math.abs(luma(data, r) - luma(data, i)) + Math.abs(luma(data, d) - luma(data, i));
        const be = (Math.abs(luma(background, r) - luma(background, i)) + Math.abs(luma(background, d) - luma(background, i))) * g;
        edge[p] = Math.abs(fe - be);
        if (fe - be > 0) appeared[p] = fe - be;
      }
    }
  }
  // the camera's own noise on this frame (the middle of the table is mostly empty)
  const sampleColour: number[] = [];
  const sampleEdge: number[] = [];
  for (let p = 0; p < colour.length; p += 23) { sampleColour.push(colour[p]!); sampleEdge.push(edge[p]!); }
  const colourThreshold = Math.max(PIXEL_THRESHOLD, median(sampleColour) * 4);
  const strongColour = colourThreshold * 2;
  const edgeThreshold = Math.max(EDGE_THRESHOLD, median(sampleEdge) * 4);

  const active = new Uint8Array(gw * gh);
  const newEdges = new Uint16Array(gw * gh);
  const needed = CELL * CELL * CELL_ACTIVE_SHARE;
  const neededEdges = Math.max(2, Math.round(CELL * CELL * 0.15));
  let activeCount = 0;
  for (let cy = 0; cy < gh; cy++) {
    for (let cx = 0; cx < gw; cx++) {
      let strong = 0;
      let edges = 0;
      let moderate = 0;
      for (let y = cy * CELL; y < (cy + 1) * CELL; y++) {
        for (let x = cx * CELL; x < (cx + 1) * CELL; x++) {
          const p = y * width + x;
          if (colour[p]! > strongColour) strong += 1;
          else if (colour[p]! > colourThreshold) moderate += 1;
          if (edge[p]! > edgeThreshold) edges += 1;
          if (appeared[p]! > edgeThreshold) newEdges[cy * gw + cx] = newEdges[cy * gw + cx]! + 1;
        }
      }
      // a big colour change on its own, or edges that weren't there (with some colour change behind them)
      if (strong >= needed || (edges >= neededEdges && strong + moderate + edges >= needed)) {
        active[cy * gw + cx] = 1;
        activeCount += 1;
      }
    }
  }

  const joined = new Uint8Array(gw * gh);
  for (let cy = 0; cy < gh; cy++) {
    for (let cx = 0; cx < gw; cx++) {
      if (!active[cy * gw + cx]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx >= 0 && ny >= 0 && nx < gw && ny < gh) joined[ny * gw + nx] = 1;
        }
      }
    }
  }

  type Blob = { minX: number; minY: number; maxX: number; maxY: number; cells: number; added: number };
  const blobs: Blob[] = [];
  const seen = new Uint8Array(gw * gh);
  const stack: number[] = [];
  for (let start = 0; start < joined.length; start++) {
    if (!joined[start] || seen[start]) continue;
    seen[start] = 1;
    stack.push(start);
    let cells = 0;
    let added = 0;
    let minX = gw;
    let minY = gh;
    let maxX = -1;
    let maxY = -1;
    while (stack.length) {
      const at = stack.pop()!;
      const cx = at % gw;
      const cy = (at - cx) / gw;
      if (active[at]) {
        cells += 1;
        added += newEdges[at]!;
        minX = Math.min(minX, cx);
        minY = Math.min(minY, cy);
        maxX = Math.max(maxX, cx);
        maxY = Math.max(maxY, cy);
      }
      const neighbours = [cx > 0 ? at - 1 : -1, cx < gw - 1 ? at + 1 : -1, cy > 0 ? at - gw : -1, cy < gh - 1 ? at + gw : -1];
      for (const n of neighbours) {
        if (n >= 0 && joined[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    blobs.push({ minX, minY, maxX, maxY, cells, added });
  }

  // Pieces within MERGE_GAP cells of each other are one thing (a crinkled clear
  // bag breaks into many) — merged BEFORE the edge test, so the pieces of
  // something half out of shot all count as that, not as objects of their own.
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < blobs.length && !merged; i++) {
      for (let j = i + 1; j < blobs.length; j++) {
        const a = blobs[i]!, b = blobs[j]!;
        if (a.minX - MERGE_GAP > b.maxX || b.minX - MERGE_GAP > a.maxX || a.minY - MERGE_GAP > b.maxY || b.minY - MERGE_GAP > a.maxY) continue;
        blobs[i] = { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY), cells: a.cells + b.cells, added: a.added + b.added };
        blobs.splice(j, 1);
        merged = true;
        break;
      }
    }
  }

  const objects: Box[] = [];
  const arms: Box[] = [];
  for (const b of blobs) {
    if (b.cells < MIN_OBJECT_CELLS) continue;
    const box: Box = { x: b.minX / gw, y: b.minY / gh, w: (b.maxX - b.minX + 1) / gw, h: (b.maxY - b.minY + 1) / gh };
    if (b.minX === 0 || b.minY === 0 || b.maxX === gw - 1 || b.maxY === gh - 1) { arms.push(box); continue; }
    // a ghost — only edges taken away, none added — is where something WAS
    if (b.added < Math.max(4, b.cells * 0.5)) continue;
    objects.push(box);
  }
  return { objects, arms, changedShare: activeCount / (gw * gh) };
}

/** Lets the picture of the empty table follow slow light changes; anything that differs (an object) is left out. */
export function absorbLight(background: Uint8ClampedArray, frame: RawFrame): void {
  const { data } = frame;
  for (let i = 0; i < background.length; i += 4) {
    const r = data[i]! - background[i]!;
    const g = data[i + 1]! - background[i + 1]!;
    const b = data[i + 2]! - background[i + 2]!;
    if (Math.abs(r) < PIXEL_THRESHOLD && Math.abs(g) < PIXEL_THRESHOLD && Math.abs(b) < PIXEL_THRESHOLD) {
      background[i] = background[i]! + Math.sign(r);
      background[i + 1] = background[i + 1]! + Math.sign(g);
      background[i + 2] = background[i + 2]! + Math.sign(b);
    }
  }
}

export const area = (b: Box): number => b.w * b.h;

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** How well a found blob continues a track: overlap over union, or a fixed score when the track sits inside it. */
function fit(track: Box, found: Box): number {
  const shared = overlapArea(track, found);
  if (!shared) return 0;
  const iou = shared / (area(track) + area(found) - shared);
  return shared / area(track) >= 0.7 ? Math.max(iou, 0.3) : iou;
}

export interface Track {
  id: number;
  box: Box;
  /** the size when it settled: what "pushed against something" is measured from */
  baseArea: number;
  lastSeenAt: number;
  stableSince: number;
  settled: boolean;
  touching: boolean;
}

export interface TrackerState {
  tracks: Track[];
  nextId: number;
}

export const emptyTracker = (): TrackerState => ({ tracks: [], nextId: 1 });

export const SETTLE_MS = 800;
export const GONE_MS = 1500;
/** a COUNTED object needs this long unseen before it's gone — a flickering box must never count twice (2026-11-03) */
export const GONE_SETTLED_MS = 3000;
const MIN_FIT = 0.25;
const MOVED = 0.015;
const TOUCHING_GROWTH = 1.6;

export interface TrackerStep {
  state: TrackerState;
  /** objects that have just come to rest: each is counted, once */
  settled: Track[];
  gone: Track[];
}

export function stepTracker(state: TrackerState, found: Pick<FoundObjects, "objects" | "arms">, now: number): TrackerStep {
  const claimed = new Set<Box>();
  const tracks: Track[] = [];
  const settled: Track[] = [];
  const gone: Track[] = [];
  const armOver = (b: Box) => found.arms.some((a) => overlapArea(a, b) > 0);

  for (const prev of state.tracks) {
    let best: Box | null = null;
    let bestFit = MIN_FIT;
    for (const o of found.objects) {
      const f = fit(prev.box, o);
      if (f >= bestFit) {
        best = o;
        bestFit = f;
      }
    }
    const next: Track = { ...prev };
    if (best) {
      claimed.add(best);
      next.lastSeenAt = now;
      if (prev.settled) {
        next.touching = area(best) > prev.baseArea * TOUCHING_GROWTH;
        // a nudge moves the box; seeing only a PIECE of it doesn't shrink it to the piece
        if (!next.touching && area(best) >= prev.baseArea * 0.6) next.box = best;
      } else {
        const moved = Math.abs(best.x - prev.box.x) + Math.abs(best.y - prev.box.y) > MOVED || Math.abs(area(best) - area(prev.box)) > area(prev.box) * 0.15;
        if (moved) next.stableSince = now;
        next.box = best;
        next.baseArea = area(best);
      }
    } else if (armOver(prev.box)) {
      next.lastSeenAt = now;
    } else if (now - prev.lastSeenAt > (prev.settled ? GONE_SETTLED_MS : GONE_MS)) {
      gone.push(prev);
      continue;
    }
    if (armOver(next.box) && !next.settled) next.stableSince = now;
    if (best && !next.settled && now - next.stableSince >= SETTLE_MS) {
      next.settled = true;
      settled.push(next);
    }
    tracks.push(next);
  }

  // A piece left over that sits mostly inside something already tracked is part
  // of it (2026-11-03: a crinkled bag broke into pieces frame by frame, and every
  // spare piece became a "new" object, settled and was read again — 131 on the
  // table). It keeps that object seen; it never starts one.
  for (const o of found.objects) {
    if (claimed.has(o)) continue;
    const owner = tracks.find((t) => overlapArea(t.box, o) >= area(o) * 0.5);
    if (owner) {
      owner.lastSeenAt = now;
      claimed.add(o);
    }
  }

  let nextId = state.nextId;
  for (const o of found.objects) {
    if (claimed.has(o)) continue;
    tracks.push({ id: nextId, box: o, baseArea: area(o), lastSeenAt: now, stableSince: now, settled: false, touching: false });
    nextId += 1;
  }
  return { state: { tracks, nextId }, settled, gone };
}

/** The crop of the full-size frame for a box, with a margin so a label at the edge isn't cut. */
export function cropRect(box: Box, videoWidth: number, videoHeight: number, pad = 0.12): { x: number; y: number; w: number; h: number } {
  const padX = box.w * pad;
  const padY = box.h * pad;
  const x = Math.max(0, Math.floor((box.x - padX) * videoWidth));
  const y = Math.max(0, Math.floor((box.y - padY) * videoHeight));
  const right = Math.min(videoWidth, Math.ceil((box.x + box.w + padX) * videoWidth));
  const bottom = Math.min(videoHeight, Math.ceil((box.y + box.h + padY) * videoHeight));
  return { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
}

/**
 * A barcode found anywhere in the full picture that belongs to this object: its
 * centre on the object, or just beside it (a box spotted a little small still
 * owns the barcode printed on it). The nearest one wins; null when none is close.
 * Boxes in fractions of the picture, like everything here.
 */
export function barcodeNear(box: Box, found: ReadonlyArray<{ value: string; box: Box }>): string | null {
  const padX = box.w * 0.6;
  const padY = box.h * 0.6;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  let best: { value: string; d: number } | null = null;
  for (const f of found) {
    const fx = f.box.x + f.box.w / 2;
    const fy = f.box.y + f.box.h / 2;
    if (fx < box.x - padX || fx > box.x + box.w + padX || fy < box.y - padY || fy > box.y + box.h + padY) continue;
    const d = (fx - cx) ** 2 + (fy - cy) ** 2;
    if (!best || d < best.d) best = { value: f.value, d };
  }
  return best?.value ?? null;
}
