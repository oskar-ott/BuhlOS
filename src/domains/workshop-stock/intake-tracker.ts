/**
 * Workshop Stock, camera table — finding objects on the table. Pure, no DOM.
 *
 * Runs in the browser on a small copy of each video frame (about 320 px wide, a
 * few times a second), compared with a picture of the empty table. It only says
 * WHERE something new is; reading what it is happens once, on a sharp crop of the
 * full frame. Video never leaves the computer.
 *
 * What it has to get right is counting each placed object once:
 *   • a blob touching the edge of the table area is an arm, not an object — it is
 *     never counted, and only what it actually lies on counts as covered;
 *   • a difference with no hard edge of its own is a shadow, or a patch where
 *     something was when the empty table was read — never an object;
 *   • an object must sit still for SETTLE_MS before it counts;
 *   • a nudged object is still the same object (the boxes overlap);
 *   • nothing leaves the table unless a hand was over it, so a shadow crossing an
 *     object, or the light changing, never makes it count twice;
 *   • a spot left empty, or a different-looking object found where a hand has
 *     just been, is a NEW object — that is how a pile gets worked through;
 *   • objects pushed together stay as they were, flagged `touching`, and any
 *     that split off again keep their identity. Only a blob no track claims is new.
 *
 * tests: intake.test.ts (the rules), intake-bench.test.ts (simulated camera).
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

/** A small picture of what's inside a box, relative to the box, so a nudge doesn't change it. */
export type Print = Float32Array;

export interface FoundObjects {
  objects: Box[];
  /** blobs touching the edge of the table area: arms, or something half out of shot */
  arms: Box[];
  /** which grid cells an arm really lies on (its box can span half the table) */
  armCells?: { gw: number; gh: number; cells: Uint8Array };
  /** patches where the picture of the empty table is wrong: something was there when it was read */
  ghosts?: Box[];
  /** how much of the table area differs from the empty table, 0–1, leaving out shadows */
  changedShare: number;
  /** the size of one grid cell, in fractions of the picture */
  cell?: { w: number; h: number };
  /** every cell near a difference, which the slow light-following must leave alone */
  busy?: { gw: number; gh: number; cells: Uint8Array };
  /** what the whole picture has shifted by (exposure, white balance), per channel */
  shift?: readonly [number, number, number];
  print?: (box: Box) => Print;
}

export interface FindOptions {
  /** how far a pixel must differ to count; from the sensor noise measured at Start */
  threshold?: number;
  /** the table area: anything outside it is ignored and its edge is the edge of the picture */
  zone?: Box | null;
}

const CELL = 4;
const PIXEL_THRESHOLD = 30;
const CELL_ACTIVE_SHARE = 0.35;
const MIN_OBJECT_CELLS = 5;
const PRINT_GRID = 6;
const MAX_LIGHT_CHANGE = 1.35;
const EDGE_MIN = 24;
/** of a blob's outline, how much must be a hard edge the empty table didn't have */
const OUTLINE_SHARE = 0.2;
const CALIBRATION_MOVED = 12;

/** The middle difference across the table, per channel: exposure and white balance shift everything, an object doesn't. */
function pictureShift(frame: RawFrame, background: ArrayLike<number>, x0: number, y0: number, x1: number, y1: number): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  const counts = [new Int32Array(511), new Int32Array(511), new Int32Array(511)];
  let n = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * frame.width + x) * 4;
      for (let c = 0; c < 3; c++) counts[c]![Math.round(frame.data[i + c]! - background[i + c]!) + 255]! += 1;
      n += 1;
    }
  }
  for (let c = 0; c < 3; c++) {
    let seen = 0;
    for (let d = 0; d < 511; d++) {
      seen += counts[c]![d]!;
      if (seen * 2 >= n) {
        out[c] = d - 255;
        break;
      }
    }
  }
  return out;
}

/** Brightness at a pixel, softened over 2×2 so sensor noise isn't taken for an edge. */
function soft(data: ArrayLike<number>, width: number, x: number, y: number): number {
  let sum = 0;
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
    const i = ((y + dy) * width + x + dx) * 4;
    sum += data[i]! + 2 * data[i + 1]! + data[i + 2]!;
  }
  return sum / 16;
}

/**
 * Whether a blob has an outline of its own. An object has hard edges the empty
 * table didn't. A shadow has none; neither does a patch where something used to be,
 * except that there the hard edges are in the picture of the empty table instead.
 */
function outline(frame: RawFrame, background: ArrayLike<number>, x0: number, y0: number, x1: number, y1: number, edge: number): "object" | "shadow" | "ghost" {
  const { width, height, data } = frame;
  const xa = Math.max(0, x0);
  const ya = Math.max(0, y0);
  const xb = Math.min(width - 3, x1);
  const yb = Math.min(height - 3, y1);
  let frameEdges = 0;
  let tableEdges = 0;
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const f = soft(data, width, x, y);
      const b = soft(background, width, x, y);
      const gf = Math.abs(soft(data, width, x + 2, y) - f) + Math.abs(soft(data, width, x, y + 2) - f);
      const gb = Math.abs(soft(background, width, x + 2, y) - b) + Math.abs(soft(background, width, x, y + 2) - b);
      if (gf > edge && gf > gb * 1.6) frameEdges += 1;
      else if (gb > edge && gb > gf * 1.6) tableEdges += 1;
    }
  }
  const needed = 2 * (xb - xa + yb - ya) * OUTLINE_SHARE;
  if (frameEdges >= needed) return "object";
  return tableEdges >= needed ? "ghost" : "shadow";
}

/**
 * Compares a frame with the empty table. A cell differs when enough of its pixels
 * do; differing cells are joined across one-cell gaps (a white label on a dark
 * box is still one object), and each joined group becomes a box around its cells.
 */
export function findObjects(frame: RawFrame, background: ArrayLike<number>, opts: FindOptions = {}): FoundObjects {
  const { width, height, data } = frame;
  const gw = Math.floor(width / CELL);
  const gh = Math.floor(height / CELL);
  if (gw < 3 || gh < 3) return { objects: [], arms: [], changedShare: 0 };
  const threshold = opts.threshold ?? PIXEL_THRESHOLD;
  const edge = Math.max(EDGE_MIN, threshold * 0.8);
  const zone = opts.zone ?? null;
  const gx0 = zone ? Math.max(0, Math.floor(zone.x * gw)) : 0;
  const gy0 = zone ? Math.max(0, Math.floor(zone.y * gh)) : 0;
  const gx1 = zone ? Math.min(gw, Math.ceil((zone.x + zone.w) * gw)) : gw;
  const gy1 = zone ? Math.min(gh, Math.ceil((zone.y + zone.h) * gh)) : gh;
  const shift = pictureShift(frame, background, gx0 * CELL, gy0 * CELL, gx1 * CELL, gy1 * CELL);
  const active = new Uint8Array(gw * gh);
  const needed = CELL * CELL * CELL_ACTIVE_SHARE;
  let activeCount = 0;
  for (let cy = gy0; cy < gy1; cy++) {
    for (let cx = gx0; cx < gx1; cx++) {
      let differing = 0;
      for (let y = cy * CELL; y < (cy + 1) * CELL; y++) {
        for (let x = cx * CELL; x < (cx + 1) * CELL; x++) {
          const i = (y * width + x) * 4;
          const d = Math.max(
            Math.abs(data[i]! - background[i]! - shift[0]),
            Math.abs(data[i + 1]! - background[i + 1]! - shift[1]),
            Math.abs(data[i + 2]! - background[i + 2]! - shift[2]),
          );
          if (d > threshold) differing += 1;
        }
      }
      if (differing >= needed) {
        active[cy * gw + cx] = 1;
        activeCount += 1;
      }
    }
  }

  const joined = new Uint8Array(gw * gh);
  for (let cy = gy0; cy < gy1; cy++) {
    for (let cx = gx0; cx < gx1; cx++) {
      if (!active[cy * gw + cx]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx >= gx0 && ny >= gy0 && nx < gx1 && ny < gy1) joined[ny * gw + nx] = 1;
        }
      }
    }
  }

  const objects: Box[] = [];
  const arms: Box[] = [];
  const ghosts: Box[] = [];
  const armCells = new Uint8Array(gw * gh);
  let shadowCells = 0;
  const seen = new Uint8Array(gw * gh);
  const stack: number[] = [];
  for (let start = 0; start < joined.length; start++) {
    if (!joined[start] || seen[start]) continue;
    seen[start] = 1;
    stack.push(start);
    const members: number[] = [];
    let minX = gw;
    let minY = gh;
    let maxX = -1;
    let maxY = -1;
    while (stack.length) {
      const at = stack.pop()!;
      const cx = at % gw;
      const cy = (at - cx) / gw;
      if (active[at]) {
        members.push(at);
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
    if (members.length < MIN_OBJECT_CELLS) continue;
    const box: Box = { x: minX / gw, y: minY / gh, w: (maxX - minX + 1) / gw, h: (maxY - minY + 1) / gh };
    const kind = outline(frame, background, (minX - 1) * CELL, (minY - 1) * CELL, (maxX + 2) * CELL, (maxY + 2) * CELL, edge);
    if (kind !== "object") {
      shadowCells += members.length;
      if (kind === "ghost") ghosts.push(box);
      continue;
    }
    if (minX === gx0 || minY === gy0 || maxX === gx1 - 1 || maxY === gy1 - 1) {
      arms.push(box);
      for (const at of members) armCells[at] = 1;
    } else {
      objects.push(box);
    }
  }
  const total = (gx1 - gx0) * (gy1 - gy0) || 1;
  return {
    objects,
    arms,
    armCells: { gw, gh, cells: armCells },
    ghosts,
    changedShare: (activeCount - shadowCells) / total,
    cell: { w: 1 / gw, h: 1 / gh },
    busy: { gw, gh, cells: joined },
    shift,
    print: (box) => printOf(frame, box, shift),
  };
}

function printOf(frame: RawFrame, box: Box, shift: readonly [number, number, number]): Print {
  const out = new Float32Array(PRINT_GRID * PRINT_GRID * 3);
  const { width, height, data } = frame;
  for (let gy = 0; gy < PRINT_GRID; gy++) {
    for (let gx = 0; gx < PRINT_GRID; gx++) {
      const x0 = Math.floor((box.x + (box.w * gx) / PRINT_GRID) * width);
      const x1 = Math.max(x0 + 1, Math.floor((box.x + (box.w * (gx + 1)) / PRINT_GRID) * width));
      const y0 = Math.floor((box.y + (box.h * gy) / PRINT_GRID) * height);
      const y1 = Math.max(y0 + 1, Math.floor((box.y + (box.h * (gy + 1)) / PRINT_GRID) * height));
      const sum = [0, 0, 0];
      let n = 0;
      for (let y = y0; y < y1 && y < height; y++) {
        for (let x = x0; x < x1 && x < width; x++) {
          const i = (y * width + x) * 4;
          for (let c = 0; c < 3; c++) sum[c]! += data[i + c]! - shift[c as 0 | 1 | 2];
          n += 1;
        }
      }
      for (let c = 0; c < 3; c++) out[(gy * PRINT_GRID + gx) * 3 + c] = n ? sum[c]! / n : 0;
    }
  }
  return out;
}

/**
 * How far apart two prints are, in levels: 0 is identical. Only the middle, because
 * a blob's outline flickers and its rim holds table and shadow. Allowed for first:
 * light changing how bright everything is. The middling difference across the
 * squares, so a shadow lying over part of it doesn't make it something else.
 */
export function printGap(a: Print, b: Print): number {
  const gain = [1, 1, 1];
  for (let c = 0; c < 3; c++) {
    let ab = 0;
    let aa = 0;
    for (let gy = 1; gy < PRINT_GRID - 1; gy++) {
      for (let gx = 1; gx < PRINT_GRID - 1; gx++) {
        const i = (gy * PRINT_GRID + gx) * 3 + c;
        ab += a[i]! * b[i]!;
        aa += a[i]! * a[i]!;
      }
    }
    gain[c] = aa ? Math.max(1 / MAX_LIGHT_CHANGE, Math.min(MAX_LIGHT_CHANGE, ab / aa)) : 1;
  }
  const gaps: number[] = [];
  for (let gy = 1; gy < PRINT_GRID - 1; gy++) {
    for (let gx = 1; gx < PRINT_GRID - 1; gx++) {
      const i = (gy * PRINT_GRID + gx) * 3;
      gaps.push((Math.abs(a[i]! * gain[0]! - b[i]!) + Math.abs(a[i + 1]! * gain[1]! - b[i + 1]!) + Math.abs(a[i + 2]! * gain[2]! - b[i + 2]!)) / 3);
    }
  }
  gaps.sort((x, y) => x - y);
  return gaps[Math.floor(gaps.length / 2)] ?? 0;
}

/**
 * Lets the picture of the empty table follow slow light changes. Only where nothing
 * is going on: an object slowly learned into the background would fade out and,
 * when it faded back, count again.
 */
export function absorbLight(background: Uint8ClampedArray, frame: RawFrame, found?: Pick<FoundObjects, "busy" | "shift" | "ghosts">, tracks: readonly Pick<Track, "box">[] = [], threshold = PIXEL_THRESHOLD): void {
  const { data, width } = frame;
  const shift = found?.shift ?? [0, 0, 0];
  const busy = found?.busy ?? null;
  const skip = busy ? busy.cells.slice() : null;
  if (skip && busy) {
    for (const t of tracks) {
      for (let cy = Math.max(0, Math.floor(t.box.y * busy.gh) - 1); cy < Math.min(busy.gh, Math.ceil((t.box.y + t.box.h) * busy.gh) + 1); cy++) {
        for (let cx = Math.max(0, Math.floor(t.box.x * busy.gw) - 1); cx < Math.min(busy.gw, Math.ceil((t.box.x + t.box.w) * busy.gw) + 1); cx++) skip[cy * busy.gw + cx] = 1;
      }
    }
  }
  for (let i = 0; i < background.length; i += 4) {
    if (skip && busy) {
      const p = i / 4;
      const x = p % width;
      const y = (p - x) / width;
      if (skip[Math.floor(y / CELL) * busy.gw + Math.floor(x / CELL)]) continue;
    }
    const r = data[i]! - background[i]! - shift[0];
    const g = data[i + 1]! - background[i + 1]! - shift[1];
    const b = data[i + 2]! - background[i + 2]! - shift[2];
    if (Math.abs(r) < threshold && Math.abs(g) < threshold && Math.abs(b) < threshold) {
      background[i] = background[i]! + Math.sign(r);
      background[i + 1] = background[i + 1]! + Math.sign(g);
      background[i + 2] = background[i + 2]! + Math.sign(b);
    }
  }
}

/** Where the picture of the empty table is wrong, it takes what's really there. */
export function clearGhosts(background: Uint8ClampedArray, frame: RawFrame, ghosts: readonly Box[], shift: readonly [number, number, number]): void {
  const { data, width, height } = frame;
  for (const g of ghosts) {
    const x0 = Math.max(0, Math.floor(g.x * width) - CELL);
    const x1 = Math.min(width, Math.ceil((g.x + g.w) * width) + CELL);
    const y0 = Math.max(0, Math.floor(g.y * height) - CELL);
    const y1 = Math.min(height, Math.ceil((g.y + g.h) * height) + CELL);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        for (let c = 0; c < 3; c++) background[i + c] = data[i + c]! - shift[c as 0 | 1 | 2];
      }
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
  /** the box when it last moved: settling is measured from here, so a one-cell flicker isn't movement */
  anchor: Box;
  lastSeenAt: number;
  stableSince: number;
  settled: boolean;
  touching: boolean;
  /** a hand has been over it since it was last seen clearly */
  disturbed: boolean;
  /** what it looked like when it settled, and the box that was over */
  print: Print | null;
  printBox: Box | null;
}

export interface EdgeRest {
  box: Box;
  since: number;
}

export interface TrackerState {
  tracks: Track[];
  nextId: number;
  edges: EdgeRest[];
}

export const emptyTracker = (): TrackerState => ({ tracks: [], nextId: 1, edges: [] });

export const SETTLE_MS = 800;
/** How long a spot stays empty, with no hand on it, before what was there has left. Short: a pile gets worked through quickly. */
export const GONE_MS = 450;
/** Something can't leave the table unless a hand was over it. After this long unseen, it has anyway: a hand nobody could see. */
const HOLD_UNSEEN_MS = 30_000;
const EDGE_REST_MS = 2500;
const MIN_FIT = 0.25;
const MOVED_CELLS = 2;
const TOUCHING_GROWTH = 1.6;
const TOUCHING_CELLS = 3;
/** Levels of difference across an object's print that mean something else is sitting there now. */
const DIFFERENT_PRINT = 15;
/** How close an arm's shadow can reach, in cells: a look at an object with a shadow on it proves nothing. */
const ARM_SHADOW_CELLS = 3;

export interface TrackerStep {
  state: TrackerState;
  /** objects that have just come to rest: each is counted, once */
  settled: Track[];
  gone: Track[];
  /** objects a hand has swapped for something that looks different */
  replaced: Track[];
  /** still things at the edge of the table area: half out of shot, so never counted */
  atEdge: Box[];
}

function coveredByArm(found: Pick<FoundObjects, "arms" | "armCells">, b: Box): boolean {
  const mask = found.armCells;
  if (!mask) return found.arms.some((a) => overlapArea(a, b) > 0);
  const x0 = Math.max(0, Math.floor(b.x * mask.gw));
  const x1 = Math.min(mask.gw, Math.ceil((b.x + b.w) * mask.gw));
  const y0 = Math.max(0, Math.floor(b.y * mask.gh));
  const y1 = Math.min(mask.gh, Math.ceil((b.y + b.h) * mask.gh));
  for (let cy = y0; cy < y1; cy++) {
    for (let cx = x0; cx < x1; cx++) if (mask.cells[cy * mask.gw + cx]) return true;
  }
  return false;
}

function movedFrom(anchor: Box, b: Box, cell: { w: number; h: number }): boolean {
  const dx = MOVED_CELLS * cell.w + 1e-6;
  const dy = MOVED_CELLS * cell.h + 1e-6;
  return Math.abs(b.x - anchor.x) > dx || Math.abs(b.x + b.w - anchor.x - anchor.w) > dx || Math.abs(b.y - anchor.y) > dy || Math.abs(b.y + b.h - anchor.y - anchor.h) > dy;
}

/**
 * Whether what's at `now` is what the track saw when it settled. Compared over the
 * box it settled with, centred on where the object is now and tried up to two cells
 * either way: a blob's outline flickers by a cell or so, its print shouldn't.
 */
function looksTheSame(track: Pick<Track, "print" | "printBox">, now: Box, print: (box: Box) => Print, cell: { w: number; h: number }): boolean {
  if (!track.print || !track.printBox) return true;
  const { w, h } = track.printBox;
  const cx = now.x + now.w / 2 - w / 2;
  const cy = now.y + now.h / 2 - h / 2;
  let closest = Infinity;
  for (let dy = -2; dy <= 2; dy += 0.5) {
    for (let dx = -2; dx <= 2; dx += 0.5) closest = Math.min(closest, printGap(track.print, print({ x: cx + dx * cell.w, y: cy + dy * cell.h, w, h })));
  }
  return closest <= DIFFERENT_PRINT;
}

export function stepTracker(state: TrackerState, found: Pick<FoundObjects, "objects" | "arms" | "armCells" | "cell" | "print">, now: number): TrackerStep {
  const claimed = new Set<Box>();
  const tracks: Track[] = [];
  const settled: Track[] = [];
  const gone: Track[] = [];
  const replaced: Track[] = [];
  const cell = found.cell ?? { w: 1 / 80, h: 1 / 45 };

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
    const covered = coveredByArm(found, prev.box);
    if (covered) next.disturbed = true;
    if (best) {
      const near = covered || coveredByArm(found, { x: prev.box.x - ARM_SHADOW_CELLS * cell.w, y: prev.box.y - ARM_SHADOW_CELLS * cell.h, w: prev.box.w + 2 * ARM_SHADOW_CELLS * cell.w, h: prev.box.h + 2 * ARM_SHADOW_CELLS * cell.h });
      const grew = area(best) > prev.baseArea * TOUCHING_GROWTH && (best.w - prev.anchor.w > TOUCHING_CELLS * cell.w || best.h - prev.anchor.h > TOUCHING_CELLS * cell.h);
      // A hand the colour of the mat still shows up as what's here suddenly changing shape.
      if (prev.settled && (grew || movedFrom(prev.box, best, cell))) next.disturbed = true;
      if (prev.settled && next.disturbed && !near && !grew && prev.print && found.print) {
        // A hand has been here, and its shadow has gone. Is it still the same thing underneath?
        next.disturbed = false;
        if (!looksTheSame(prev, best, found.print, cell)) {
          gone.push(prev);
          replaced.push(prev);
          continue;
        }
      }
      claimed.add(best);
      next.lastSeenAt = now;
      if (prev.settled) {
        next.touching = grew;
        if (!next.touching) next.box = best;
      } else {
        if (movedFrom(prev.anchor, best, cell)) {
          next.stableSince = now;
          next.anchor = best;
        }
        next.box = best;
        next.baseArea = area(best);
      }
    } else if (covered) {
      next.lastSeenAt = now;
    } else if (now - prev.lastSeenAt > GONE_MS && (!prev.settled || next.disturbed || now - prev.lastSeenAt > HOLD_UNSEEN_MS)) {
      // Unseen with no hand ever over it is a shadow or the light, not an object leaving.
      gone.push(prev);
      continue;
    }
    if (coveredByArm(found, next.box) && !next.settled) next.stableSince = now;
    if (best && !next.settled && now - next.stableSince >= SETTLE_MS) {
      next.settled = true;
      next.print = found.print ? found.print(next.box) : null;
      next.printBox = next.box;
      settled.push(next);
    }
    tracks.push(next);
  }

  let nextId = state.nextId;
  for (const o of found.objects) {
    if (claimed.has(o)) continue;
    tracks.push({ id: nextId, box: o, baseArea: area(o), anchor: o, lastSeenAt: now, stableSince: now, settled: false, touching: false, disturbed: false, print: null, printBox: null });
    nextId += 1;
  }

  const edges: EdgeRest[] = found.arms.map((box) => {
    const was = state.edges.find((e) => !movedFrom(e.box, box, cell));
    return { box: was ? was.box : box, since: was ? was.since : now };
  });
  const atEdge = edges.filter((e) => now - e.since >= EDGE_REST_MS).map((e) => e.box);
  return { state: { tracks, nextId, edges }, settled, gone, replaced, atEdge };
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

/** How sharp a picture is: the spread of a small edge filter. A webcam refocusing scores far lower than one in focus. */
export function sharpness(frame: RawFrame): number {
  const { data, width, height } = frame;
  const lum = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return (data[i]! + 2 * data[i + 1]! + data[i + 2]!) / 4;
  };
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const v = 4 * lum(x, y) - lum(x - 1, y) - lum(x + 1, y) - lum(x, y - 1) - lum(x, y + 1);
      sum += v;
      sumSq += v * v;
      n += 1;
    }
  }
  return n ? sumSq / n - (sum / n) ** 2 : 0;
}

// ── reading the empty table ───────────────────────────────────────────────────

export interface TableCheck {
  /** something moved while it was being read */
  moved: boolean;
  /** sensor noise, levels */
  noise: number;
  /** average brightness, 0–255 */
  brightness: number;
  /** speckle the table itself has, levels */
  texture: number;
  /** share of the picture blown out to white */
  blown: number;
}

export interface Calibration {
  sum: Float32Array | null;
  first: Uint8ClampedArray | null;
  last: ArrayLike<number> | null;
  frames: number;
  moved: boolean;
  width: number;
  height: number;
}

export const newCalibration = (): Calibration => ({ sum: null, first: null, last: null, frames: 0, moved: false, width: 0, height: 0 });

function cellMean(data: ArrayLike<number>, width: number, cx: number, cy: number): number {
  let sum = 0;
  for (let y = cy * CELL; y < (cy + 1) * CELL; y++) {
    for (let x = cx * CELL; x < (cx + 1) * CELL; x++) sum += data[(y * width + x) * 4 + 1]!;
  }
  return sum / (CELL * CELL);
}

export function addCalibrationFrame(c: Calibration, frame: RawFrame): void {
  const { data, width, height } = frame;
  if (!c.sum || c.sum.length !== data.length) {
    c.sum = new Float32Array(data.length);
    c.first = Uint8ClampedArray.from(data as ArrayLike<number>);
    c.frames = 0;
    c.moved = false;
    c.width = width;
    c.height = height;
  } else if (!c.moved && c.first) {
    const gw = Math.floor(width / CELL);
    const gh = Math.floor(height / CELL);
    let changed = 0;
    for (let cy = 0; cy < gh; cy++) {
      for (let cx = 0; cx < gw; cx++) if (Math.abs(cellMean(data, width, cx, cy) - cellMean(c.first, width, cx, cy)) > CALIBRATION_MOVED) changed += 1;
    }
    if (changed > gw * gh * 0.01) c.moved = true;
  }
  const sum = c.sum;
  for (let i = 0; i < sum.length; i++) sum[i] = sum[i]! + data[i]!;
  c.last = data;
  c.frames += 1;
}

export interface TableReading {
  background: Uint8ClampedArray;
  threshold: number;
  check: TableCheck;
}

export function finishCalibration(c: Calibration): TableReading | null {
  if (!c.sum || !c.frames || !c.first || !c.last) return null;
  const background = new Uint8ClampedArray(c.sum.length);
  for (let i = 0; i < c.sum.length; i++) background[i] = c.sum[i]! / c.frames;
  let diff = 0;
  let bright = 0;
  let blown = 0;
  let texture = 0;
  let n = 0;
  for (let i = 0; i + 8 < background.length; i += 8) {
    const g = background[i + 1]!;
    diff += Math.abs(c.first[i + 1]! - c.last[i + 1]!);
    bright += g;
    if (g >= 250) blown += 1;
    texture += Math.abs(g - background[i + 5]!);
    n += 1;
  }
  // Two readings of the same pixel differ by about 1.13 × the noise on average.
  const noise = c.frames > 1 && n ? diff / n / 1.13 : 0;
  return {
    background,
    threshold: Math.round(Math.max(20, Math.min(40, noise * 3.5))),
    check: { moved: c.moved, noise, brightness: n ? bright / n : 0, texture: n ? texture / n : 0, blown: n ? blown / n : 0 },
  };
}

/** What's worth fixing about the table, in order, or null. Only what was measured. */
export function tableAdvice(check: TableCheck): { code: "moved" | "dark" | "blown" | "busy" | "noisy"; text: string } | null {
  if (check.moved) return { code: "moved", text: "Something moved while the empty table was being read. Keep hands and things out of shot and press Reset table." };
  if (check.blown > 0.25) return { code: "blown", text: "Much of the table is blown out to white, so labels and white items will wash out. Turn the light down or use a darker mat." };
  if (check.brightness < 45) return { code: "dark", text: "The table is dark, which makes labels hard to read. More light will help." };
  if (check.noise > 9) return { code: "noisy", text: "The picture is grainy, so small items may be missed. More light will help." };
  if (check.texture > 9) return { code: "busy", text: "The table has a busy pattern, which makes items harder to pick out. A plain mat will help." };
  return null;
}

// ── one frame, start to finish ────────────────────────────────────────────────

export interface TableState {
  background: Uint8ClampedArray;
  threshold: number;
  zone: Box | null;
  tracker: TrackerState;
}

const CAMERA_CHANGED_SHARE = 0.5;

export interface FrameResult {
  found: FoundObjects;
  /** most of the picture has changed: the camera moved, nothing is being counted */
  stopped: boolean;
  step: TrackerStep | null;
}

/** One frame through the whole chain. Changes `table`: the tracker, and the picture of the empty table. */
export function analyseFrame(table: TableState, frame: RawFrame, now: number): FrameResult {
  const found = findObjects(frame, table.background, { threshold: table.threshold, zone: table.zone });
  if (found.changedShare > CAMERA_CHANGED_SHARE) return { found, stopped: true, step: null };
  if (found.ghosts?.length && found.shift) clearGhosts(table.background, frame, found.ghosts, found.shift);
  const step = stepTracker(table.tracker, found, now);
  table.tracker = step.state;
  absorbLight(table.background, frame, found, step.state.tracks, table.threshold);
  return { found, stopped: false, step };
}
