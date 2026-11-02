/**
 * A simulated overhead webcam, for testing the camera table's detection without a
 * camera. Test-only: nothing in the app imports this.
 *
 * It draws what the canvas webcam in camera-table.e2e.spec.ts never had: sensor
 * noise, auto-exposure and white balance shifting the whole picture, arms and the
 * shadows they cast, and items close to the colour of the mat. It proves how the
 * tracker behaves against those things. It is NOT evidence about a real webcam.
 */

export type Rgb = readonly [number, number, number];

export interface SimThing {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  colour: Rgb;
  /** dark rectangles printed on it, in fractions of the item: labels, barcodes, text */
  marks?: ReadonlyArray<{ x: number; y: number; w: number; h: number; colour?: Rgb }>;
}

export interface SimArm {
  from: readonly [number, number];
  to: readonly [number, number];
  /** fraction of picture width */
  width: number;
  colour: Rgb;
}

export interface SimShadow {
  x: number;
  y: number;
  /** radius, fraction of picture width */
  r: number;
  /** 0–1: how much light it takes away at its middle */
  strength: number;
  /** 0 = a hard edge, 1 = fades from the middle */
  soft: number;
}

export interface SimScene {
  mat: Rgb;
  /** speckle baked into the mat, levels: 0 = flat colour, 12 = wood grain or a busy bench */
  texture: number;
  /** sensor noise, standard deviation in levels */
  noise: number;
  /** auto-exposure and white balance: multiplies everything the camera sees */
  gain: Rgb;
  things: SimThing[];
  arms: SimArm[];
  shadows: SimShadow[];
}

export const WIDTH = 320;
export const HEIGHT = 180;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

export interface SimCamera {
  scene: SimScene;
  frame(): { data: Uint8ClampedArray; width: number; height: number };
}

export function simCamera(scene: Partial<SimScene> = {}, seed = 7): SimCamera {
  const state: SimScene = { mat: [70, 110, 90], texture: 0, noise: 3, gain: [1, 1, 1], things: [], arms: [], shadows: [], ...scene };
  const random = rng(seed);
  // Gaussian noise, from a table so a long run stays quick.
  const gauss = new Float32Array(8192);
  for (let i = 0; i < gauss.length; i++) gauss[i] = Math.sqrt(-2 * Math.log(random() || 1e-6)) * Math.cos(2 * Math.PI * random());
  // The mat's own grain never changes between frames.
  const grain = new Float32Array(WIDTH * HEIGHT);
  for (let i = 0; i < grain.length; i++) grain[i] = gauss[Math.floor(random() * gauss.length)]!;
  const light = new Float32Array(WIDTH * HEIGHT);
  const pixel = new Float32Array(WIDTH * HEIGHT * 3);
  return {
    scene: state,
    frame() {
      for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
          const i = y * WIDTH + x;
          // A real table is never evenly lit: a few percent brighter at one side.
          const fall = 1 - 0.06 * (x / WIDTH) - 0.04 * (y / HEIGHT);
          const speck = state.texture * grain[i]!;
          pixel[i * 3] = state.mat[0] * fall + speck;
          pixel[i * 3 + 1] = state.mat[1] * fall + speck;
          pixel[i * 3 + 2] = state.mat[2] * fall + speck;
          light[i] = 1;
        }
      }
      for (const t of state.things) {
        const x0 = Math.round(t.x * WIDTH);
        const y0 = Math.round(t.y * HEIGHT);
        const x1 = Math.round((t.x + t.w) * WIDTH);
        const y1 = Math.round((t.y + t.h) * HEIGHT);
        // Its own contact shadow, a pixel or two along one side.
        for (let y = y0 + 2; y < y1 + 2 && y < HEIGHT; y++) {
          for (let x = x0 + 2; x < x1 + 2 && x < WIDTH; x++) {
            if (x >= x1 || y >= y1) light[y * WIDTH + x] = Math.min(light[y * WIDTH + x]!, 0.82);
          }
        }
        for (let y = Math.max(0, y0); y < y1 && y < HEIGHT; y++) {
          for (let x = Math.max(0, x0); x < x1 && x < WIDTH; x++) {
            const i = y * WIDTH + x;
            pixel[i * 3] = t.colour[0];
            pixel[i * 3 + 1] = t.colour[1];
            pixel[i * 3 + 2] = t.colour[2];
          }
        }
        for (const m of t.marks ?? []) {
          const mx0 = Math.round((t.x + m.x * t.w) * WIDTH);
          const my0 = Math.round((t.y + m.y * t.h) * HEIGHT);
          const mx1 = Math.round((t.x + (m.x + m.w) * t.w) * WIDTH);
          const my1 = Math.round((t.y + (m.y + m.h) * t.h) * HEIGHT);
          const c = m.colour ?? ([35, 35, 40] as const);
          for (let y = Math.max(0, my0); y < my1 && y < HEIGHT; y++) {
            for (let x = Math.max(0, mx0); x < mx1 && x < WIDTH; x++) {
              const i = y * WIDTH + x;
              pixel[i * 3] = c[0];
              pixel[i * 3 + 1] = c[1];
              pixel[i * 3 + 2] = c[2];
            }
          }
        }
      }
      for (const s of state.shadows) {
        const r = s.r * WIDTH;
        const cx = s.x * WIDTH;
        const cy = s.y * HEIGHT;
        for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(HEIGHT, Math.ceil(cy + r)); y++) {
          for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(WIDTH, Math.ceil(cx + r)); x++) {
            const d = Math.hypot(x - cx, y - cy) / r;
            if (d >= 1) continue;
            const edge = s.soft <= 0 ? 1 : Math.min(1, (1 - d) / s.soft);
            light[y * WIDTH + x] = light[y * WIDTH + x]! * (1 - s.strength * edge);
          }
        }
      }
      for (const a of state.arms) {
        const half = (a.width * WIDTH) / 2;
        const ax = a.from[0] * WIDTH;
        const ay = a.from[1] * HEIGHT;
        const bx = a.to[0] * WIDTH;
        const by = a.to[1] * HEIGHT;
        const len2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
        const pad = half + 8;
        for (let y = Math.max(0, Math.floor(Math.min(ay, by) - pad)); y < Math.min(HEIGHT, Math.ceil(Math.max(ay, by) + pad)); y++) {
          for (let x = Math.max(0, Math.floor(Math.min(ax, bx) - pad)); x < Math.min(WIDTH, Math.ceil(Math.max(ax, by, bx) + pad)); x++) {
            const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2));
            const d = Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)));
            const i = y * WIDTH + x;
            if (d <= half) {
              pixel[i * 3] = a.colour[0];
              pixel[i * 3 + 1] = a.colour[1];
              pixel[i * 3 + 2] = a.colour[2];
              light[i] = 1;
            } else if (d <= half + 7) {
              // the soft shadow an arm throws on what's under it
              light[i] = Math.min(light[i]!, 0.72 + 0.28 * ((d - half) / 7));
            }
          }
        }
      }
      const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
      let n = Math.floor(random() * gauss.length);
      for (let i = 0; i < WIDTH * HEIGHT; i++) {
        for (let c = 0; c < 3; c++) {
          n = (n + 1) % gauss.length;
          data[i * 4 + c] = pixel[i * 3 + c]! * light[i]! * state.gain[c as 0 | 1 | 2] + gauss[n]! * state.noise;
        }
        data[i * 4 + 3] = 255;
      }
      return { data, width: WIDTH, height: HEIGHT };
    },
  };
}

export const ARM_SKIN: Rgb = [190, 140, 110];

/** A cardboard box with a white label, on the default mat. */
export function box(id: string, x: number, y: number, w = 0.1, h = 0.14): SimThing {
  return {
    id, x, y, w, h, colour: [190, 165, 120],
    marks: [
      { x: 0.1, y: 0.15, w: 0.8, h: 0.4, colour: [235, 235, 230] },
      { x: 0.15, y: 0.2, w: 0.6, h: 0.08 },
      { x: 0.15, y: 0.35, w: 0.45, h: 0.08 },
      { x: 0.15, y: 0.65, w: 0.7, h: 0.2 },
    ],
  };
}
