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

/** The middle brightness difference across the picture: a light going on shifts everything, an object doesn't. */
function brightnessShift(frame: RawFrame, background: ArrayLike<number>): number {
  const counts = new Int32Array(511);
  let n = 0;
  for (let i = 0; i < frame.data.length; i += 16) {
    const d = Math.round((frame.data[i]! + frame.data[i + 1]! + frame.data[i + 2]! - background[i]! - background[i + 1]! - background[i + 2]!) / 3);
    counts[d + 255]! += 1;
    n += 1;
  }
  let seen = 0;
  for (let d = 0; d < counts.length; d++) {
    seen += counts[d]!;
    if (seen * 2 >= n) return d - 255;
  }
  return 0;
}

/**
 * Compares a frame with the empty table. A cell differs when enough of its pixels
 * do; differing cells are joined across one-cell gaps (a white label on a dark
 * box is still one object), and each joined group becomes a box around its cells.
 */
export function findObjects(frame: RawFrame, background: ArrayLike<number>): FoundObjects {
  const { width, height, data } = frame;
  const gw = Math.floor(width / CELL);
  const gh = Math.floor(height / CELL);
  if (gw < 3 || gh < 3) return { objects: [], arms: [], changedShare: 0 };
  const shift = brightnessShift(frame, background);
  const active = new Uint8Array(gw * gh);
  const needed = CELL * CELL * CELL_ACTIVE_SHARE;
  let activeCount = 0;
  for (let cy = 0; cy < gh; cy++) {
    for (let cx = 0; cx < gw; cx++) {
      let differing = 0;
      for (let y = cy * CELL; y < (cy + 1) * CELL; y++) {
        for (let x = cx * CELL; x < (cx + 1) * CELL; x++) {
          const i = (y * width + x) * 4;
          const d = Math.max(
            Math.abs(data[i]! - background[i]! - shift),
            Math.abs(data[i + 1]! - background[i + 1]! - shift),
            Math.abs(data[i + 2]! - background[i + 2]! - shift),
          );
          if (d > PIXEL_THRESHOLD) differing += 1;
        }
      }
      if (differing >= needed) {
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

  const objects: Box[] = [];
  const arms: Box[] = [];
  const seen = new Uint8Array(gw * gh);
  const stack: number[] = [];
  for (let start = 0; start < joined.length; start++) {
    if (!joined[start] || seen[start]) continue;
    seen[start] = 1;
    stack.push(start);
    let cells = 0;
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
    if (cells < MIN_OBJECT_CELLS) continue;
    const box: Box = { x: minX / gw, y: minY / gh, w: (maxX - minX + 1) / gw, h: (maxY - minY + 1) / gh };
    if (minX === 0 || minY === 0 || maxX === gw - 1 || maxY === gh - 1) arms.push(box);
    else objects.push(box);
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
        if (!next.touching) next.box = best;
      } else {
        const moved = Math.abs(best.x - prev.box.x) + Math.abs(best.y - prev.box.y) > MOVED || Math.abs(area(best) - area(prev.box)) > area(prev.box) * 0.15;
        if (moved) next.stableSince = now;
        next.box = best;
        next.baseArea = area(best);
      }
    } else if (armOver(prev.box)) {
      next.lastSeenAt = now;
    } else if (now - prev.lastSeenAt > GONE_MS) {
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
