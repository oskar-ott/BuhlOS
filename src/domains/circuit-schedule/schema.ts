import { z } from "zod";

/**
 * Circuit Schedule Builder — domain model (AU / AS-NZS 3000 conventions).
 *
 * Ported from the BuhlOS Circuit Schedule design. A `Board` (distribution board /
 * switchboard) has supply metadata and a list of `Circuit` rows (one per way).
 * The live compute engine — voltage drop, phase balance, capacity, spare ways,
 * per-row warnings — is PURE and lives in `compute.ts`; reference tables and the
 * quick-add presets live here. Schemas are `.passthrough()` for forward-compat,
 * matching the test-records / job-control convention.
 *
 * Reference values (copper, thermoplastic V90) are INDICATIVE — the on-site
 * design must be verified against AS/NZS 3000 & AS/NZS 3008. The UI says so.
 */

/* ── fixed-choice enums ─────────────────────────────────────────────────── */
export const DEVICES = ["MCB", "RCBO", "RCD", "MCCB"] as const;
export const POLES = ["1P", "2P", "3P"] as const;
export const MAIN_POLES = ["1P", "2P", "3P", "4P"] as const;
export const CURVES = ["B", "C", "D"] as const;
export const CORES = ["TPS", "V90", "XLPE", "SDI"] as const;
export const PHASES = ["A", "B", "C"] as const;
export const LOAD_UNITS = ["A", "kW"] as const;
export const RCD_OPTIONS = ["none", "30mA", "10mA", "100mA", "300mA"] as const;
export const SUPPLY_TYPES = ["1ph", "3ph"] as const;
export const BOARD_STATUSES = ["draft", "active", "issued"] as const;
/** Load category — drives the RCD-required rule and the quick-add presets. */
export const CIRCUIT_TYPES = [
  "lighting", "gpo", "oven", "ac", "ev", "water", "submain", "data", "motor",
] as const;

export const DeviceSchema = z.enum(DEVICES);
export const PolesSchema = z.enum(POLES);
export const CurveSchema = z.enum(CURVES);
export const CoresSchema = z.enum(CORES);
export const LoadUnitSchema = z.enum(LOAD_UNITS);
export const SupplySchema = z.enum(SUPPLY_TYPES);
export const BoardStatusSchema = z.enum(BOARD_STATUSES);
export const CircuitTypeSchema = z.enum(CIRCUIT_TYPES);

export type Device = z.infer<typeof DeviceSchema>;
export type Poles = z.infer<typeof PolesSchema>;
export type Supply = z.infer<typeof SupplySchema>;
export type BoardStatus = z.infer<typeof BoardStatusSchema>;
export type CircuitType = z.infer<typeof CircuitTypeSchema>;

/* ── reference tables (copper, V90 — indicative) ────────────────────────── */
/** mV/A/m by active CSA (mm²), single-phase 2-core+earth. 3-phase ×0.866. */
export const MVAM: Record<number, number> = {
  1: 44, 1.5: 29.4, 2.5: 17.6, 4: 11.0, 6: 7.32, 10: 4.40, 16: 2.78,
  25: 1.75, 35: 1.27, 50: 0.94, 70: 0.65, 95: 0.49, 120: 0.39, 150: 0.32, 185: 0.26,
};
/** Current-carrying capacity (A) by CSA — partially enclosed, conservative. */
export const CCC: Record<number, number> = {
  1: 14, 1.5: 18, 2.5: 25, 4: 32, 6: 40, 10: 56, 16: 75,
  25: 98, 35: 119, 50: 145, 70: 185, 95: 224, 120: 260, 150: 299, 185: 341,
};
/** Ascending list of standard CSAs (mm²). */
export const CSAS: number[] = Object.keys(MVAM).map(Number).sort((a, b) => a - b);
/** Voltage-drop budget (%) — consumer mains + final subcircuit. */
export const VD_LIMIT = 5;

/** Load types that require 30 mA RCD protection as a final subcircuit. */
export const RCD_REQUIRED_TYPES: Record<string, boolean> = {
  lighting: true, gpo: true, ac: true, ev: true, oven: true, data: true,
  water: false, submain: false, motor: false,
};

/* ── Circuit (one way) ──────────────────────────────────────────────────── */
export const CircuitSchema = z
  .object({
    id: z.string().min(1),
    way: z.number(),
    desc: z.string(),
    type: z.string(), // CircuitType, but kept open (drives the RCD rule via a lookup)
    /** L1/L2/L3 allocation (3-phase boards); "" / unset on single-phase. */
    phase: z.string().optional(),
    device: z.string(),
    rating: z.number(),
    poles: z.string(),
    curve: z.string(),
    kA: z.number(),
    /** "none" | "30mA" | … */
    rcd: z.string(),
    /** RCD type letter "A" | "B" | "AC" | "". */
    rcdType: z.string().optional(),
    /** Active conductor CSA (mm²). */
    active: z.number(),
    /** Neutral/earth CSA (mm²). */
    neut: z.number(),
    cores: z.string(),
    /** Run length (m). */
    length: z.number(),
    /** Installation / reference method (free text). */
    method: z.string(),
    /** Connected load. */
    load: z.number(),
    loadUnit: z.string(), // "A" | "kW"
    notes: z.string().optional().default(""),
  })
  .passthrough();
export type Circuit = z.infer<typeof CircuitSchema>;

/* ── Board (distribution board / switchboard) ───────────────────────────── */
export const BoardSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    ref: z.string(),
    location: z.string(),
    /** Where the board is fed from (upstream board / utility). */
    suppliedFrom: z.string(),
    supply: SupplySchema,
    voltage: z.number(),
    /** Main switch rating (A). */
    mainRating: z.number(),
    mainPoles: z.string(),
    /** Prospective fault level (kA). */
    faultKA: z.number(),
    mainRcd: z.boolean(),
    /** Surge protection device fitted. */
    spd: z.boolean(),
    /** Way capacity. */
    ways: z.number(),
    status: BoardStatusSchema,
    /** Display metadata — last edit summary (not authoritative). */
    updated: z.string().optional().default(""),
    updatedBy: z.string().optional().default(""),
    circuits: z.array(CircuitSchema).default([]),
  })
  .passthrough();
export type Board = z.infer<typeof BoardSchema>;

/* ── quick-add presets (device + cable defaults the user can tweak) ─────── */
export interface CircuitPreset {
  key: string;
  label: string;
  type: CircuitType;
  desc: string;
  device: Device;
  rating: number;
  poles: Poles;
  curve: string;
  kA: number;
  rcd: string;
  rcdType: string;
  active: number;
  neut: number;
  cores: string;
  method: string;
  load: number;
  loadUnit: string;
}

export const PRESETS: CircuitPreset[] = [
  { key: "light", label: "Lighting", type: "lighting", desc: "Lighting — ", device: "RCBO", rating: 10, poles: "1P", curve: "C", kA: 6, rcd: "30mA", rcdType: "A", active: 1.5, neut: 1.5, cores: "TPS", method: "Enclosed in wall", load: 6, loadUnit: "A" },
  { key: "gpo", label: "GPOs", type: "gpo", desc: "GPOs — ", device: "RCBO", rating: 20, poles: "1P", curve: "C", kA: 6, rcd: "30mA", rcdType: "A", active: 2.5, neut: 2.5, cores: "TPS", method: "Enclosed in wall", load: 16, loadUnit: "A" },
  { key: "oven", label: "Oven / cooktop", type: "oven", desc: "Oven + cooktop", device: "RCBO", rating: 32, poles: "1P", curve: "C", kA: 6, rcd: "30mA", rcdType: "A", active: 6, neut: 6, cores: "TPS", method: "Enclosed in wall", load: 28, loadUnit: "A" },
  { key: "ac", label: "A/C unit", type: "ac", desc: "A/C — ", device: "RCBO", rating: 16, poles: "1P", curve: "C", kA: 6, rcd: "30mA", rcdType: "A", active: 2.5, neut: 2.5, cores: "TPS", method: "Enclosed in wall", load: 13, loadUnit: "A" },
  { key: "ev", label: "EV charger", type: "ev", desc: "EV charger", device: "RCBO", rating: 32, poles: "1P", curve: "C", kA: 6, rcd: "30mA", rcdType: "B", active: 6, neut: 6, cores: "V90", method: "Surface conduit", load: 32, loadUnit: "A" },
  { key: "hws", label: "Hot water", type: "water", desc: "Hot water — storage", device: "MCB", rating: 20, poles: "1P", curve: "C", kA: 6, rcd: "none", rcdType: "", active: 2.5, neut: 2.5, cores: "TPS", method: "Enclosed in wall", load: 15, loadUnit: "A" },
  { key: "submain", label: "Sub-main", type: "submain", desc: "Sub-main to ", device: "MCCB", rating: 63, poles: "3P", curve: "C", kA: 10, rcd: "none", rcdType: "", active: 16, neut: 16, cores: "XLPE", method: "Cable ladder", load: 48, loadUnit: "A" },
  { key: "data", label: "Mech / data", type: "data", desc: "Comms rack — ", device: "RCBO", rating: 20, poles: "1P", curve: "C", kA: 6, rcd: "30mA", rcdType: "A", active: 2.5, neut: 2.5, cores: "TPS", method: "On cable tray", load: 12, loadUnit: "A" },
];

export const CIRCUIT_SCHEDULE_ID_PREFIX = "c";
