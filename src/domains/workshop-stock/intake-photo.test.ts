import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error pngjs ships no types
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { addCalibrationFrame, analyseFrame, emptyTracker, finishCalibration, newCalibration, type RawFrame, type TableState } from "./intake-tracker";

/**
 * The camera table against pixels from a real webcam: three clear bags of switch
 * mechs on a woodgrain desk, from the owner's screenshot of it going wrong
 * (2026-11-03, Razer Kiyo, 1080p). Same photo, so the table under the bags is
 * partly rebuilt and the arm is drawn: exposure, focus and vibration are put on
 * top. It catches what flat-coloured simulations can't. It is still one photo,
 * not video from the camera.
 */

const W = 640;
const H = 360;
const FRAME_MS = 150;
const dir = join(process.cwd(), "tests/fixtures/camera-table");
const load = (name: string) => PNG.sync.read(readFileSync(join(dir, `${name}.png`))).data;
const table = load("table");
const bags = load("bags");

// Where each bag lies, in fractions of the picture.
const BAGS = {
  a: { x0: 0.085, y0: 0.064, x1: 0.426, y1: 0.439, hand: [0.26, 0.26] },
  b: { x0: 0.457, y0: 0.04, x1: 0.798, y1: 0.383, hand: [0.63, 0.21] },
  c: { x0: 0.439, y0: 0.388, x1: 0.803, y1: 0.753, hand: [0.62, 0.57] },
} as const;
type BagName = keyof typeof BAGS;

interface Shot {
  bags: BagName[];
  /** hand position in fractions of the picture, with an arm coming up from the bottom */
  hand?: readonly [number, number] | null;
  /** how much of the bag can be seen: a very clear bag only shows its label, product and glare */
  showing?: number;
  /** moves a bag down the picture, in pixels of the 640 wide picture */
  nudge?: Partial<Record<BagName, number>>;
  /** a hard-edged patch of light, from a window or a reflection, in levels */
  glare?: number;
}

interface Camera {
  gain: readonly [number, number, number];
  gamma: number;
  /** pixels of focus blur */
  blur: number;
  /** vibration, in pixels */
  shake: readonly [number, number];
}

const steady: Camera = { gain: [1, 1, 1], gamma: 1, blur: 0, shake: [0, 0] };

const scenes = new Map<string, Float32Array>();

function compose(shot: Shot): Float32Array {
  const key = JSON.stringify(shot);
  const hit = scenes.get(key);
  if (hit) return hit;
  const out = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = table[i * 4 + c]!;
  for (const name of shot.bags) {
    const b = BAGS[name];
    const down = shot.nudge?.[name] ?? 0;
    for (let y = Math.floor(b.y0 * H); y < b.y1 * H; y++) {
      for (let x = Math.floor(b.x0 * W); x < b.x1 * W; x++) {
        const i = y * W + x;
        if (y + down >= H || y + down < 0) continue;
        const to = (y + down) * W + x;
        const off = Math.abs(bags[i * 4]! - table[i * 4]!) + Math.abs(bags[i * 4 + 1]! - table[i * 4 + 1]!) + Math.abs(bags[i * 4 + 2]! - table[i * 4 + 2]!);
        if (off < (shot.showing ?? 6)) continue;
        for (let c = 0; c < 3; c++) out[to * 3 + c] = bags[i * 4 + c]!;
      }
    }
  }
  if (shot.glare) {
    for (let y = Math.floor(0.55 * H); y < 0.72 * H; y++) {
      for (let x = Math.floor(0.08 * W); x < 0.3 * W; x++) {
        const i = (y * W + x) * 3;
        for (let c = 0; c < 3; c++) out[i + c] = out[i + c]! + shot.glare;
      }
    }
  }
  if (shot.hand) {
    const hx = shot.hand[0] * W;
    const hy = shot.hand[1] * H;
    const ax = hx * 0.9;
    const ay = H - 1;
    const r = 32;
    const len2 = (hx - ax) ** 2 + (hy - ay) ** 2 || 1;
    for (let y = Math.max(0, Math.floor(hy - r - 20)); y < H; y++) {
      for (let x = Math.max(0, Math.floor(Math.min(ax, hx) - r - 20)); x < Math.min(W, Math.max(ax, hx) + r + 20); x++) {
        const t = Math.max(0, Math.min(1, ((x - ax) * (hx - ax) + (y - ay) * (hy - ay)) / len2));
        const d = Math.hypot(x - (ax + t * (hx - ax)), y - (ay + t * (hy - ay)));
        const i = (y * W + x) * 3;
        if (d <= r) {
          out[i] = 188;
          out[i + 1] = 140;
          out[i + 2] = 112;
        } else if (d <= r + 18) {
          const k = 0.72 + 0.28 * ((d - r) / 18);
          for (let c = 0; c < 3; c++) out[i + c] = out[i + c]! * k;
        }
      }
    }
  }
  if (scenes.size > 64) scenes.clear();
  scenes.set(key, out);
  return out;
}

let seed = 9;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

/** The webcam, then the browser shrinking it to 320 wide with averaging, as the screen now does. */
function shoot(shot: Shot, cam: Camera): RawFrame {
  const full = compose(shot);
  const sw = W / 2;
  const sh = H / 2;
  const data = new Uint8ClampedArray(sw * sh * 4);
  const bx = Math.round(cam.blur);
  const dx = Math.round(cam.shake[0]);
  const dy = Math.round(cam.shake[1]);
  const at = (x: number, y: number, c: number) => full[(Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))) * 3 + c]!;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const o = (y * sw + x) * 4;
      for (let c = 0; c < 3; c++) {
        const px = x * 2 + dx;
        const py = y * 2 + dy;
        let v = (at(px, py, c) + at(px + 1, py, c) + at(px, py + 1, c) + at(px + 1, py + 1, c)) / 4;
        if (bx) v = (v + at(px - bx, py - bx, c) + at(px + bx, py + bx, c) + at(px - bx, py + bx, c) + at(px + bx, py - bx, c)) / 5;
        data[o + c] = 255 * Math.pow(v / 255, cam.gamma) * cam.gain[c as 0 | 1 | 2] + (random() - 0.5) * 4;
      }
      data[o + 3] = 255;
    }
  }
  return { data, width: sw, height: sh };
}

function startTable(): { table: TableState; t: number; counted: number[]; gone: number[] } {
  const c = newCalibration();
  for (let i = 0; i < 8; i++) addCalibrationFrame(c, shoot({ bags: [] }, steady));
  const read = finishCalibration(c)!;
  return { table: { background: read.background, threshold: read.threshold, zone: null, tracker: emptyTracker() }, t: 0, counted: [], gone: [] };
}

function run(s: ReturnType<typeof startTable>, shot: Shot, cam: Camera | ((t: number) => Camera), ms: number) {
  for (const end = s.t + ms; s.t < end; s.t += FRAME_MS) {
    const r = analyseFrame(s.table, shoot(shot, typeof cam === "function" ? cam(s.t) : cam), s.t);
    for (const t of r.step?.settled ?? []) s.counted.push(t.id);
    for (const t of r.step?.gone ?? []) s.gone.push(t.id);
  }
}

/** Exposure, white balance and focus hunting, as a consumer webcam does by itself. */
function hunting(t: number): Camera {
  const wave = (f: number, p = 0) => Math.sin(t * f + p);
  const g = 1 + 0.05 * wave(0.0011);
  return { gain: [g, g * (1 + 0.015 * wave(0.0007, 1)), g * (1 + 0.03 * wave(0.0009, 2))], gamma: 1 + 0.05 * wave(0.0013, 1), blur: wave(0.002, 3) > 0.3 ? 1 : 0, shake: [Math.round(wave(0.017)), 0] };
}

function place(s: ReturnType<typeof startTable>, on: BagName[], name: BagName, cam: Camera | ((t: number) => Camera), look: Pick<Shot, "showing" | "nudge"> = {}) {
  const [hx, hy] = BAGS[name].hand;
  for (const f of [0.3, 0.6, 1]) run(s, { bags: on, hand: [hx, 1 - (1 - hy) * f], ...look }, cam, FRAME_MS);
  on.push(name);
  run(s, { bags: on, hand: [hx, hy + 0.05], ...look }, cam, 450);
  for (const f of [0.6, 0.3]) run(s, { bags: on, hand: [hx, 1 - (1 - hy) * f], ...look }, cam, FRAME_MS);
}

describe("the camera table on a real photo", () => {
  it("sees nothing on the empty table, while the webcam hunts", () => {
    const s = startTable();
    run(s, { bags: [] }, hunting, 15_000);
    expect(s.counted).toEqual([]);
  });

  it("counts three clear bags as three, one at a time, with the camera steady", () => {
    const s = startTable();
    const on: BagName[] = [];
    run(s, { bags: [] }, steady, 1500);
    for (const name of ["a", "b", "c"] as const) {
      place(s, on, name, steady);
      run(s, { bags: on }, steady, 2500);
    }
    expect(s.counted.length).toBe(3);
  });

  it("counts three clear bags as three while the webcam hunts", () => {
    const s = startTable();
    const on: BagName[] = [];
    run(s, { bags: [] }, hunting, 1500);
    for (const name of ["a", "b", "c"] as const) {
      place(s, on, name, hunting);
      run(s, { bags: on }, hunting, 4000);
    }
    expect(s.counted.length).toBe(3);
  });

  it.each([
    ["10% darker", { ...steady, gain: [0.9, 0.9, 0.9] }],
    ["15% darker", { ...steady, gain: [0.85, 0.85, 0.85] }],
    ["25% darker", { ...steady, gain: [0.75, 0.75, 0.75] }],
    ["15% brighter", { ...steady, gain: [1.15, 1.15, 1.15] }],
    ["warmer", { ...steady, gain: [1.1, 1, 0.88] }],
    ["darker and warmer", { ...steady, gain: [0.95, 0.85, 0.75] }],
    ["gamma", { ...steady, gamma: 1.15 }],
  ] as ReadonlyArray<[string, Camera]>)("doesn't count anything new when exposure jumps: %s", (_name, cam) => {
    const s = startTable();
    const on: BagName[] = [];
    for (const name of ["a", "b", "c"] as const) {
      place(s, on, name, steady);
      run(s, { bags: on }, steady, 2000);
    }
    expect(s.counted.length).toBe(3);
    run(s, { bags: on }, cam, 8000);
    expect(s.counted.length).toBe(3);
    expect(s.gone).toEqual([]);
  });

  it.each([[60], [90], [130]])("counts a very clear bag as one, showing only what differs by %i levels", (showing) => {
    const s = startTable();
    const on: BagName[] = [];
    for (const name of ["a", "b", "c"] as const) {
      place(s, on, name, steady, { showing });
      run(s, { bags: on, showing }, steady, 2500);
    }
    expect(s.counted.length).toBe(3);
  });

  it.each([[1], [0.95], [0.9], [0.85]])("settles when bags go down together by hand, however close, at exposure %f", (gain) => {
    const s = startTable();
    const shaky = (t: number): Camera => ({ gain: [gain, gain, gain], gamma: 1, blur: Math.sin(t * 0.002) > 0.3 ? 1 : 0, shake: [Math.round(Math.sin(t * 0.017)), 0] });
    const all: BagName[] = ["a", "b", "c"];
    for (const f of [0.3, 0.6, 1]) run(s, { bags: [], hand: [0.44, 1 - 0.6 * f] }, shaky, FRAME_MS);
    run(s, { bags: all, hand: [0.44, 0.4] }, shaky, 450);
    for (const f of [0.6, 0.3]) run(s, { bags: all, hand: [0.44, 1 - 0.6 * f] }, shaky, FRAME_MS);
    run(s, { bags: all }, shaky, 8000);
    // This close they may read as fewer things, but never more, and never none: a box flipping every frame would settle on nothing.
    expect(s.counted.length).toBeGreaterThanOrEqual(1);
    expect(s.counted.length).toBeLessThanOrEqual(3);
    expect(s.table.tracker.tracks.filter((t) => !t.settled)).toEqual([]);
  });

  it("keeps a bag put down almost touching the last one separate", () => {
    const s = startTable();
    const on: BagName[] = [];
    const nudge = { c: -8 };
    place(s, on, "b", steady, { nudge });
    run(s, { bags: on, nudge }, steady, 2500);
    place(s, on, "c", steady, { nudge });
    run(s, { bags: on, nudge }, steady, 2500);
    expect(s.counted.length).toBe(2);
  });

  it("doesn't count a patch of glare creeping in with no hand", () => {
    const s = startTable();
    run(s, { bags: [] }, steady, 1000);
    for (let glare = 6; glare <= 60; glare += 6) run(s, { bags: [], glare }, steady, 450);
    run(s, { bags: [], glare: 60 }, steady, 6000);
    expect(s.counted).toEqual([]);
    expect(s.table.tracker.tracks).toEqual([]);
  });

  it("takes a bag off and counts it again when it's put back", () => {
    const s = startTable();
    const on: BagName[] = [];
    place(s, on, "a", steady);
    run(s, { bags: on }, steady, 2000);
    place(s, on, "b", steady);
    run(s, { bags: on }, steady, 2000);
    expect(s.counted.length).toBe(2);
    run(s, { bags: on, hand: BAGS.b.hand }, steady, 600);
    run(s, { bags: ["a"], hand: BAGS.b.hand }, steady, 300);
    run(s, { bags: ["a"] }, steady, 2000);
    expect(s.gone.length).toBe(1);
    place(s, ["a"], "b", steady);
    run(s, { bags: ["a", "b"] }, steady, 2000);
    expect(s.counted.length).toBe(3);
  });
});
