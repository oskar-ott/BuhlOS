import { describe, expect, it } from "vitest";
import { addCalibrationFrame, analyseFrame, emptyTracker, finishCalibration, newCalibration, type TableCheck, type TableState } from "./intake-tracker";
import { ARM_SKIN, box, simCamera, type SimArm, type SimCamera, type SimThing } from "./intake-sim";

const STEP = 150;

class Table {
  table: TableState | null = null;
  now = 1_000_000;
  counted: number[] = [];
  settleLag: number[] = [];
  lastArmAt = 0;
  atEdge = 0;
  check: TableCheck | null = null;
  constructor(public cam: SimCamera) {}
  calibrate() {
    const c = newCalibration();
    for (let f = 0; f < 8; f++) {
      addCalibrationFrame(c, this.cam.frame());
      this.now += STEP;
    }
    const read = finishCalibration(c)!;
    this.check = read.check;
    this.table = { background: read.background, threshold: read.threshold, zone: null, tracker: this.table?.tracker ?? emptyTracker() };
  }
  tick(n = 1) {
    for (let k = 0; k < n; k++) {
      const r = analyseFrame(this.table!, this.cam.frame(), this.now);
      if (r.found.arms.length) this.lastArmAt = this.now;
      if (r.step) {
        this.atEdge = r.step.atEdge.length;
        for (const t of r.step.settled) {
          this.counted.push(t.id);
          this.settleLag.push(this.now - this.lastArmAt);
        }
      }
      this.now += STEP;
    }
  }
  seconds(s: number) { this.tick(Math.round((s * 1000) / STEP)); }
}

/** A hand comes in from the nearest side, puts the thing down and leaves: about 1.2 s, like a person. */
function place(t: Table, thing: SimThing, from: readonly [number, number] = [thing.x + thing.w / 2, 1.05], stay = 2) {
  const to = [thing.x + thing.w / 2, thing.y + thing.h / 2] as const;
  const arm: SimArm = { from, to: from, width: 0.07, colour: ARM_SKIN };
  t.cam.scene.arms.push(arm);
  for (let i = 1; i <= 4; i++) { arm.to = [from[0] + ((to[0] - from[0]) * i) / 4, from[1] + ((to[1] - from[1]) * i) / 4]; t.tick(); }
  t.cam.scene.things.push(thing);
  t.tick(stay);
  for (let i = 3; i >= 0; i--) { arm.to = [from[0] + ((to[0] - from[0]) * i) / 4, from[1] + ((to[1] - from[1]) * i) / 4]; t.tick(); }
  t.cam.scene.arms.splice(t.cam.scene.arms.indexOf(arm), 1);
}

/** A hand comes in, picks the thing up and leaves with it. */
function lift(t: Table, id: string, from?: readonly [number, number]) {
  const thing = t.cam.scene.things.find((x) => x.id === id)!;
  const start = from ?? ([thing.x + thing.w / 2, 1.05] as const);
  const to = [thing.x + thing.w / 2, thing.y + thing.h / 2] as const;
  const arm: SimArm = { from: start, to: start, width: 0.07, colour: ARM_SKIN };
  t.cam.scene.arms.push(arm);
  for (let i = 1; i <= 4; i++) { arm.to = [start[0] + ((to[0] - start[0]) * i) / 4, start[1] + ((to[1] - start[1]) * i) / 4]; t.tick(); }
  t.cam.scene.things.splice(t.cam.scene.things.indexOf(thing), 1);
  t.tick(1);
  for (let i = 3; i >= 0; i--) { arm.to = [start[0] + ((to[0] - start[0]) * i) / 4, start[1] + ((to[1] - start[1]) * i) / 4]; t.tick(); }
  t.cam.scene.arms.splice(t.cam.scene.arms.indexOf(arm), 1);
}

interface Row { name: string; want: number; got: number; note?: string }
let results: Row[] = [];
let seed = 7;

function run(name: string, want: number, scene: Parameters<typeof simCamera>[0], script: (t: Table) => void | string) {
  const t = new Table(simCamera(scene, seed));
  t.calibrate();
  const note = script(t);
  results.push({ name, want, got: t.counted.length, note: note || (t.settleLag.length ? `settled ${(Math.max(...t.settleLag) / 1000).toFixed(1)}s after arm left` : undefined) });
}

const WHITE_MAT = [225, 225, 220] as const;

function allScenarios() {
    run("one box, clean sensor", 1, { noise: 3 }, (t) => { place(t, box("a", 0.4, 0.4)); t.seconds(4); });
    run("one box, noisy sensor (dim room)", 1, { noise: 8 }, (t) => { place(t, box("a", 0.4, 0.4)); t.seconds(4); });
    run("one box, very noisy", 1, { noise: 12 }, (t) => { place(t, box("a", 0.4, 0.4)); t.seconds(6); });
    run("small part (3% wide)", 1, { noise: 5 }, (t) => { place(t, { id: "a", x: 0.5, y: 0.5, w: 0.03, h: 0.05, colour: [230, 230, 225] }); t.seconds(4); });
    run("small part, noisy", 1, { noise: 9 }, (t) => { place(t, { id: "a", x: 0.5, y: 0.5, w: 0.03, h: 0.05, colour: [230, 230, 225] }); t.seconds(6); });
    run("white switch on white mat", 1, { mat: WHITE_MAT, noise: 5 }, (t) => {
      place(t, { id: "a", x: 0.4, y: 0.35, w: 0.12, h: 0.2, colour: [240, 240, 236], marks: [{ x: 0.1, y: 0.05, w: 0.25, h: 0.12 }, { x: 0.65, y: 0.78, w: 0.25, h: 0.12 }] });
      t.seconds(5);
    });
    run("two boxes one after another", 2, { noise: 5 }, (t) => { place(t, box("a", 0.2, 0.3)); t.seconds(1.5); place(t, box("b", 0.6, 0.3)); t.seconds(3); });
    run("swap: take off, next in same spot (0.6s gap)", 2, { noise: 5 }, (t) => { place(t, box("a", 0.4, 0.4)); t.seconds(1.5); lift(t, "a"); t.seconds(0.6); place(t, box("b", 0.4, 0.4)); t.seconds(3); });
    run("swap: hand never leaves the picture", 2, { noise: 5 }, (t) => {
      place(t, box("a", 0.4, 0.4)); t.seconds(1.5);
      const hold: SimArm = { from: [0.45, 1.05], to: [0.45, 0.5], width: 0.07, colour: ARM_SKIN };
      t.cam.scene.arms.push(hold); t.tick(2);
      t.cam.scene.things.length = 0; t.tick(1);
      t.cam.scene.things.push(box("b", 0.41, 0.41)); t.cam.scene.things[0]!.colour = [60, 60, 180]; t.tick(1);
      t.cam.scene.arms.length = 0; t.seconds(3);
    });
    run("arm resting across table, item placed under its span", 1, { noise: 5 }, (t) => {
      t.cam.scene.arms.push({ from: [-0.02, -0.05], to: [0.75, 0.9], width: 0.08, colour: ARM_SKIN });
      t.tick(3);
      t.cam.scene.things.push(box("a", 0.62, 0.15));
      t.seconds(4);
    });
    run("auto-exposure drops 18% as a dark box lands", 1, { noise: 4 }, (t) => {
      place(t, { id: "a", x: 0.4, y: 0.35, w: 0.2, h: 0.3, colour: [30, 30, 32] });
      t.cam.scene.gain = [0.82, 0.82, 0.82]; t.seconds(4);
    });
    run("white balance swings warm", 0, { noise: 4 }, (t) => { t.seconds(1); t.cam.scene.gain = [1.12, 1, 0.86]; t.seconds(5); });
    run("exposure jumps on a white mat", 0, { mat: WHITE_MAT, noise: 4 }, (t) => { t.seconds(1); t.cam.scene.gain = [0.75, 0.75, 0.75]; t.seconds(5); });
    run("soft shadow drifts in and stops mid-table", 0, { noise: 4 }, (t) => {
      for (let i = 0; i < 8; i++) { t.cam.scene.shadows = [{ x: 0.15 + i * 0.05, y: 0.5, r: 0.18, strength: 0.55, soft: 1 }]; t.tick(); }
      t.seconds(5);
    });
    run("person leans over: hard-ish shadow, then gone", 0, { noise: 4 }, (t) => {
      t.cam.scene.shadows = [{ x: 0.5, y: 0.5, r: 0.14, strength: 0.5, soft: 0.25 }]; t.seconds(4); t.cam.scene.shadows = []; t.seconds(3);
    });
    run("low-contrast item left 2 minutes", 1, { noise: 6, mat: [120, 120, 118] }, (t) => {
      place(t, { id: "a", x: 0.4, y: 0.4, w: 0.15, h: 0.2, colour: [158, 158, 156] });
      t.seconds(120);
      return `${t.table!.tracker.tracks.length} track(s) still held`;
    });
    run("stray item left at Start, then taken away", 0, { noise: 5 }, (t) => {
      // the picture of the empty table was taken with it there
      t.cam.scene.things.push(box("stray", 0.4, 0.4));
      t.calibrate();
      lift(t, "stray"); t.seconds(4);
    });
    run("hand in shot while the empty table is read", 0, { noise: 5 }, (t) => {
      t.cam.scene.arms.push({ from: [0.5, 1.05], to: [0.5, 0.5], width: 0.07, colour: ARM_SKIN });
      t.calibrate();
      t.cam.scene.arms.length = 0; t.seconds(4);
    });
    run("second box stacked on the first", 2, { noise: 5 }, (t) => {
      place(t, box("a", 0.4, 0.4)); t.seconds(1.5);
      place(t, { ...box("b", 0.405, 0.41, 0.09, 0.12), colour: [60, 90, 170] }); t.seconds(3);
    });
    run("sleeve the colour of the mat: hand holds still", 0, { noise: 5 }, (t) => {
      t.cam.scene.arms.push({ from: [0.5, 1.05], to: [0.5, 0.75], width: 0.07, colour: [72, 112, 92] });
      t.cam.scene.arms.push({ from: [0.5, 0.75], to: [0.5, 0.55], width: 0.06, colour: ARM_SKIN });
      t.seconds(3); t.cam.scene.arms.length = 0; t.seconds(2);
    });
    run("busy wood-grain bench", 1, { noise: 5, texture: 12, mat: [140, 105, 70] }, (t) => { t.seconds(1); place(t, box("a", 0.4, 0.4)); t.seconds(4); });
    run("twenty items in a row", 20, { noise: 6 }, (t) => {
      for (let n = 0; n < 20; n++) {
        const col = n % 5; const row = Math.floor(n / 5);
        place(t, box(`i${n}`, 0.06 + col * 0.18, 0.08 + row * 0.22, 0.09, 0.12)); t.seconds(1.2);
      }
      t.seconds(2);
    });
    run("pile through: 15 placed and taken in one spot", 15, { noise: 6 }, (t) => {
      for (let n = 0; n < 15; n++) { place(t, box(`i${n}`, 0.42, 0.42)); t.seconds(1.2); lift(t, `i${n}`); t.seconds(0.3); }
      t.seconds(2);
    });
    run("low-contrast small part in a noisy room", 1, { noise: 7, mat: [120, 120, 118] }, (t) => { place(t, { id: "a", x: 0.5, y: 0.5, w: 0.05, h: 0.08, colour: [165, 165, 160] }); t.seconds(6); });
    run("white balance swings on a white mat", 0, { mat: WHITE_MAT, noise: 4 }, (t) => { t.seconds(1); t.cam.scene.gain = [1.12, 1, 0.86]; t.seconds(5); });
    run("box taken away with nothing replacing it", 1, { noise: 5 }, (t) => { place(t, box("a", 0.4, 0.4)); t.seconds(1.5); lift(t, "a"); t.seconds(3); });
    run("a logged box nudged by hand stays one", 1, { noise: 5 }, (t) => {
      place(t, box("a", 0.4, 0.4)); t.seconds(1.5);
      t.cam.scene.arms.push({ from: [0.45, 1.05], to: [0.45, 0.47], width: 0.07, colour: ARM_SKIN }); t.tick(3);
      t.cam.scene.things[0]!.x += 0.012; t.tick(2);
      t.cam.scene.arms.length = 0; t.seconds(3);
    });
    run("hand rests on a logged box a few seconds", 1, { noise: 5 }, (t) => {
      place(t, box("a", 0.4, 0.4)); t.seconds(1.5);
      t.cam.scene.arms.push({ from: [0.45, 1.05], to: [0.45, 0.47], width: 0.07, colour: ARM_SKIN }); t.seconds(3);
      t.cam.scene.arms.length = 0; t.seconds(3);
    });
    run("exposure jumps while a hand is over the box", 1, { noise: 5 }, (t) => {
      place(t, box("a", 0.4, 0.4)); t.seconds(1.5);
      t.cam.scene.arms.push({ from: [0.45, 1.05], to: [0.45, 0.47], width: 0.07, colour: ARM_SKIN }); t.tick(3);
      t.cam.scene.gain = [0.85, 0.85, 0.85]; t.tick(3);
      t.cam.scene.arms.length = 0; t.seconds(3);
    });
    run("item half out of shot is not counted, and flagged", 0, { noise: 5 }, (t) => {
      place(t, box("a", 0.95, 0.4, 0.12, 0.14)); t.seconds(4);
      return t.atEdge ? "flagged at the edge" : "NOT flagged";
    });
    run("two boxes placed touching (known limit: counts 1)", 1, { noise: 5 }, (t) => {
      t.cam.scene.things.push(box("a", 0.4, 0.4), box("b", 0.5, 0.4)); t.seconds(3);
    });
    run("same product swapped with the spot never empty (known limit)", 1, { noise: 5 }, (t) => {
      place(t, box("a", 0.4, 0.4)); t.seconds(1.5);
      t.cam.scene.arms.push({ from: [0.45, 1.05], to: [0.45, 0.47], width: 0.07, colour: ARM_SKIN }); t.tick(2);
      t.cam.scene.things.length = 0; t.tick(1); t.cam.scene.things.push(box("b", 0.4, 0.4)); t.tick(1);
      t.cam.scene.arms.length = 0; t.seconds(3);
    });
}

describe("the camera table against a simulated camera", () => {
  for (const s of process.env.BENCH_ALL_SEEDS ? [7, 23, 101, 202, 303] : [7]) {
    it(`counts every scenario right, seed ${s}`, () => {
      seed = s;
      results = [];
      allScenarios();
      const wrong = results.filter((r) => r.got !== r.want).map((r) => `${r.name}: wanted ${r.want}, got ${r.got}`);
      expect(wrong).toEqual([]);
      expect(results.find((r) => r.name.startsWith("item half out"))?.note).toBe("flagged at the edge");
    }, 240_000);
  }
});

/**
 * A soak nobody hand-picked: random items in random spots under drifting light, with
 * random hands. It reports a rate rather than asserting perfection, because it is
 * there to find what the scenarios above didn't think of.
 */
describe("a random soak", () => {
  function soak(seedValue: number, scene: Parameters<typeof simCamera>[0], ops: number) {
    let r = seedValue;
    const rand = () => { r = (r * 1664525 + 1013904223) >>> 0; return r / 4294967296; };
    const t = new Table(simCamera(scene, seedValue));
    t.calibrate();
    const slots = Array.from({ length: 12 }, (_, i) => ({ x: 0.06 + (i % 4) * 0.23, y: 0.08 + Math.floor(i / 4) * 0.3, used: null as string | null }));
    let placed = 0;
    let n = 0;
    for (let op = 0; op < ops; op++) {
      const free = slots.filter((s) => !s.used);
      const used = slots.filter((s) => s.used);
      const roll = rand();
      if (roll < 0.55 && free.length) {
        const slot = free[Math.floor(rand() * free.length)]!;
        const id = `t${n++}`;
        const w = 0.04 + rand() * 0.1;
        const h = 0.06 + rand() * 0.14;
        const thing = rand() < 0.5
          ? box(id, slot.x, slot.y, w, h)
          : { id, x: slot.x, y: slot.y, w, h, colour: [40 + rand() * 200, 40 + rand() * 200, 40 + rand() * 200] as const, marks: [{ x: 0.2, y: 0.2, w: 0.6, h: 0.3 }] };
        place(t, thing);
        slot.used = id;
        placed += 1;
        t.seconds(1 + rand() * 1.2);
      } else if (roll < 0.8 && used.length) {
        const slot = used[Math.floor(rand() * used.length)]!;
        lift(t, slot.used!);
        slot.used = null;
        t.seconds(0.3 + rand());
      } else if (roll < 0.9) {
        t.cam.scene.gain = [0.9 + rand() * 0.2, 0.9 + rand() * 0.2, 0.9 + rand() * 0.2];
        t.seconds(1);
      } else {
        t.cam.scene.shadows = [{ x: rand(), y: rand(), r: 0.1 + rand() * 0.15, strength: 0.3 + rand() * 0.3, soft: 0.6 + rand() * 0.4 }];
        t.seconds(1.5);
        t.cam.scene.shadows = [];
      }
    }
    t.seconds(3);
    return { placed, counted: t.counted.length };
  }

  it("stays close to the truth, whatever comes", () => {
    const rows: string[] = [];
    let wrong = 0;
    let total = 0;
    const seeds = process.env.BENCH_ALL_SEEDS ? [1, 2, 3, 4, 5, 6] : [1];
    for (const seedValue of seeds) {
      for (const [name, scene] of [
        ["mid mat, clean", { noise: 4 }],
        ["mid mat, grainy", { noise: 9 }],
        ["white mat", { noise: 5, mat: [225, 225, 220] as const }],
        ["dark mat", { noise: 5, mat: [35, 38, 42] as const }],
        ["wood bench", { noise: 5, mat: [140, 105, 70] as const, texture: 10 }],
      ] as const) {
        const res = soak(seedValue * 97, scene, process.env.BENCH_ALL_SEEDS ? 80 : 30);
        wrong += Math.abs(res.counted - res.placed);
        total += res.placed;
        rows.push(`${name} seed ${seedValue}: placed ${res.placed}, counted ${res.counted}`);
      }
    }
    console.log(`\n${rows.join("\n")}\nmiscounted ${wrong} of ${total} (${((wrong / total) * 100).toFixed(1)}%)`);
    expect(wrong / total).toBeLessThan(0.03);
  }, 600_000);
});
