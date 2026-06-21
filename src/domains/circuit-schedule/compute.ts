import {
  type Board,
  type Circuit,
  type CircuitPreset,
  MVAM,
  CCC,
  CSAS,
  VD_LIMIT,
  RCD_REQUIRED_TYPES,
  CIRCUIT_SCHEDULE_ID_PREFIX,
} from "./schema";

/**
 * Circuit Schedule — the live compute engine. PURE: no I/O, no React, no Blob.
 * Voltage drop, RCD-required, cable capacity, phase balance, board totals and
 * greedy auto-balance — the AS/NZS 3000 / 3008 derivations the builder and the
 * print preview both read from. Reference values are indicative (see schema.ts).
 */

export interface RowWarning {
  sev: "red" | "amber";
  code: "Vd" | "RCD" | "CSA";
  msg: string;
}
export interface PhaseLoads {
  A: number;
  B: number;
  C: number;
}
export interface Balance extends PhaseLoads {
  max: number;
  min: number;
  avg: number;
  imb: number;
  status: "ok" | "caution" | "bad";
}
export interface BoardTotals {
  used: number;
  spare: number;
  connected: number;
  loadPct: number;
  overloaded: boolean;
  warnCount: number;
  errCount: number;
}

const nearestUp = (v: number, list: number[]): number =>
  list.find((x) => x >= v) ?? list[list.length - 1] ?? v;

const phaseKey = (phase: string | undefined): keyof PhaseLoads =>
  phase === "B" ? "B" : phase === "C" ? "C" : "A";

/** Design current (A). kW loads convert at 0.85 PF (3-phase) / 0.95 (single). */
export function rowCurrent(c: Circuit): number {
  if (c.loadUnit === "kW") {
    return c.poles === "3P"
      ? (Number(c.load) * 1000) / (400 * 1.732 * 0.85)
      : (Number(c.load) * 1000) / (230 * 0.95);
  }
  return Number(c.load) || 0;
}

/** Voltage drop (%) over the run, from the mV/A/m table (3-phase ×0.866). */
export function rowVd(c: Circuit): number {
  const I = rowCurrent(c);
  const csa = nearestUp(Number(c.active) || 1, CSAS);
  const mvam = MVAM[csa] ?? MVAM[1] ?? 44;
  if (c.poles === "3P") {
    const v = (mvam * 0.866 * I * (Number(c.length) || 0)) / 1000;
    return (v / 400) * 100;
  }
  const v = (mvam * I * (Number(c.length) || 0)) / 1000;
  return (v / 230) * 100;
}

/** Does this load type need 30 mA RCD protection as a final subcircuit? */
export function rcdRequired(c: Circuit): boolean {
  return !!RCD_REQUIRED_TYPES[c.type] && (Number(c.rating) || 0) <= 63;
}
/** Is RCD protection present (device-integral or an explicit RCD value)? */
export function hasRcd(c: Circuit): boolean {
  return c.device === "RCBO" || c.device === "RCD" || (!!c.rcd && c.rcd !== "none");
}

/** Per-row advisory warnings: voltage drop, missing RCD, cable under-capacity. */
export function rowWarnings(c: Circuit): RowWarning[] {
  const w: RowWarning[] = [];
  const vd = rowVd(c);
  if (vd > VD_LIMIT) w.push({ sev: "red", code: "Vd", msg: `Voltage drop ${vd.toFixed(1)}% > ${VD_LIMIT}% limit` });
  else if (vd > VD_LIMIT - 0.8) w.push({ sev: "amber", code: "Vd", msg: `Voltage drop ${vd.toFixed(1)}% — near ${VD_LIMIT}% limit` });

  if (rcdRequired(c) && !hasRcd(c)) w.push({ sev: "red", code: "RCD", msg: "RCD (30 mA) required for this final subcircuit" });

  const csa = nearestUp(Number(c.active) || 1, CSAS);
  const cap = CCC[csa] || 0;
  if ((Number(c.rating) || 0) > cap) w.push({ sev: "red", code: "CSA", msg: `${c.rating} A device exceeds ${csa} mm² capacity (${cap} A)` });
  else if ((Number(c.rating) || 0) > cap * 0.9) w.push({ sev: "amber", code: "CSA", msg: `${c.rating} A device close to ${csa} mm² capacity (${cap} A)` });

  return w;
}

/** Per-phase connected current (A). 3-phase circuits load all three phases. */
export function phaseLoads(board: Board): PhaseLoads {
  const t: PhaseLoads = { A: 0, B: 0, C: 0 };
  board.circuits.forEach((c) => {
    const I = rowCurrent(c);
    if (c.poles === "3P") {
      t.A += I;
      t.B += I;
      t.C += I;
    } else {
      t[phaseKey(c.phase)] += I;
    }
  });
  return t;
}

/** Phase-balance summary (3-phase only). imbalance % over the average phase. */
export function balance(board: Board): Balance | null {
  if (board.supply !== "3ph") return null;
  const t = phaseLoads(board);
  const vals = [t.A, t.B, t.C];
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const avg = (t.A + t.B + t.C) / 3 || 1;
  const imb = ((max - min) / avg) * 100;
  const status: Balance["status"] = imb <= 12 ? "ok" : imb <= 28 ? "caution" : "bad";
  return { ...t, max, min, avg, imb, status };
}

/** Board rollup: ways used/spare, connected load vs main rating, issue counts. */
export function totals(board: Board): BoardTotals {
  const used = board.circuits.length;
  const spare = Math.max(0, board.ways - used);
  let connected = 0;
  if (board.supply === "3ph") {
    const t = phaseLoads(board);
    connected = Math.max(t.A, t.B, t.C); // worst-phase amps vs main rating
  } else {
    connected = board.circuits.reduce((s, c) => s + rowCurrent(c), 0);
  }
  const loadPct = connected / (board.mainRating || 1);
  let warnCount = 0;
  let errCount = 0;
  board.circuits.forEach((c) => rowWarnings(c).forEach((x) => (x.sev === "red" ? errCount++ : warnCount++)));
  const overloaded = connected > board.mainRating;
  if (overloaded) {
    if (loadPct > 1.1) errCount++;
    else warnCount++;
  }
  return { used, spare, connected, loadPct, overloaded, warnCount, errCount };
}

/**
 * Greedy phase re-assignment to flatten imbalance — single-phase circuits only
 * (3-phase circuits already load all phases). Returns a NEW board (immutable),
 * suitable for a React state update; never mutates the input.
 */
export function autoBalance(board: Board): Board {
  const t: PhaseLoads = { A: 0, B: 0, C: 0 };
  board.circuits
    .filter((c) => c.poles === "3P")
    .forEach((c) => {
      const I = rowCurrent(c);
      t.A += I;
      t.B += I;
      t.C += I;
    });
  const next = board.circuits.map((c) => ({ ...c }));
  next
    .filter((c) => c.poles !== "3P")
    .sort((a, b) => rowCurrent(b) - rowCurrent(a))
    .forEach((c) => {
      const ph: keyof PhaseLoads = t.A <= t.B && t.A <= t.C ? "A" : t.B <= t.C ? "B" : "C";
      c.phase = ph;
      t[ph] += rowCurrent(c);
    });
  return { ...board, circuits: next };
}

/* ── id + preset helpers (used by the builder UI) ───────────────────────── */
let _uid = 1000;
/** Monotonic client-side circuit id. Persistence assigns its own ids later. */
export const newCircuitId = (): string => CIRCUIT_SCHEDULE_ID_PREFIX + ++_uid;

/** Build a circuit from a quick-add preset at the given way. */
export function fromPreset(p: CircuitPreset, way: number): Circuit {
  return {
    id: newCircuitId(),
    way,
    desc: p.desc,
    type: p.type,
    phase: "A",
    device: p.device,
    rating: p.rating,
    poles: p.poles,
    curve: p.curve,
    kA: p.kA,
    rcd: p.rcd,
    rcdType: p.rcdType,
    active: p.active,
    neut: p.neut,
    cores: p.cores,
    length: 22,
    method: p.method,
    load: p.load,
    loadUnit: p.loadUnit,
    notes: "",
  };
}
