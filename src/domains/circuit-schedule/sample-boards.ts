import { type Board, type Circuit } from "./schema";

/**
 * Sample circuit-schedule data — the "100 Arthur" job, matching the rest of the
 * BuhlOS sample set. Used to render the builder before persistence is wired
 * (the screens are honest that this is sample data). Ids are deterministic
 * (`<boardId>:w<way>`) so server and client render identically.
 */

export const SAMPLE_JOB = {
  id: "P25-014",
  name: "100 Arthur",
  client: "Thomas Bros (builder)",
  addr: "100 Arthur St, Adelaide",
  drawing: "DWG 25275N",
};

// Positional builder mirroring the design's C(...) helper, with a deterministic id.
type CircuitArgs = [
  way: number, desc: string, type: string, phase: string, device: string,
  rating: number, poles: string, curve: string, kA: number, rcd: string,
  rcdType: string, active: number, neut: number, cores: string, length: number,
  method: string, load: number, loadUnit: string, notes?: string,
];
const mk = (boardId: string) => (...a: CircuitArgs): Circuit => {
  const [way, desc, type, phase, device, rating, poles, curve, kA, rcd, rcdType, active, neut, cores, length, method, load, loadUnit, notes = ""] = a;
  return { id: `${boardId}:w${way}`, way, desc, type, phase, device, rating, poles, curve, kA, rcd, rcdType, active, neut, cores, length, method, load, loadUnit, notes };
};

const msb = mk("MSB-100");
const l2 = mk("DB-L2");
const gf = mk("DB-GF");

export const SAMPLE_BOARDS: Board[] = [
  {
    id: "MSB-100", name: "Main switchboard", ref: "MSB", location: "GF · main riser cupboard",
    suppliedFrom: "Ausgrid · street pillar", supply: "3ph", voltage: 415, mainRating: 400, mainPoles: "4P",
    faultKA: 10, mainRcd: false, spd: true, ways: 24, status: "active",
    updated: "Today · 14:20", updatedBy: "Kane Bell · on site",
    circuits: [
      msb(1, "Sub-main → DB-GF (reception)", "submain", "A", "MCCB", 100, "3P", "C", 10, "none", "", 35, 16, "XLPE", 28, "Cable ladder · riser", 78, "A"),
      msb(4, "Sub-main → DB-L2 (office)", "submain", "A", "MCCB", 63, "3P", "C", 10, "none", "", 16, 16, "XLPE", 46, "Cable ladder · riser", 52, "A"),
      msb(7, "Sub-main → DB-L3 (comms)", "submain", "A", "MCCB", 63, "3P", "C", 10, "none", "", 16, 16, "XLPE", 61, "Cable ladder · riser", 41, "A"),
      msb(10, "Mech · AHU-1 chiller", "motor", "A", "MCCB", 40, "3P", "D", 10, "none", "", 10, 10, "XLPE", 38, "Cable tray · plant", 34, "A"),
      msb(13, "Mech · AHU-2", "motor", "A", "MCCB", 32, "3P", "D", 10, "none", "", 6, 6, "XLPE", 42, "Cable tray · plant", 28, "A"),
      msb(16, "Lift controller", "submain", "A", "MCCB", 40, "3P", "C", 10, "none", "", 10, 10, "XLPE", 55, "Riser", 26, "A"),
      msb(19, "House light + emergency", "lighting", "A", "RCBO", 16, "1P", "C", 6, "30mA", "A", 2.5, 2.5, "TPS", 44, "On tray", 12, "A"),
      msb(20, "House GPO · plant + riser", "gpo", "B", "RCBO", 20, "1P", "C", 6, "30mA", "A", 2.5, 2.5, "TPS", 40, "On tray", 14, "A"),
      msb(21, "Fire indicator panel", "data", "C", "RCBO", 10, "1P", "C", 6, "30mA", "A", 2.5, 2.5, "TPS", 18, "Surface conduit", 6, "A"),
      msb(22, "Comms · main rack feed", "data", "B", "RCBO", 20, "1P", "C", 6, "30mA", "A", 2.5, 2.5, "TPS", 52, "On tray", 16, "A", "Vd to watch — long run"),
      msb(23, "Security + access control", "data", "C", "RCBO", 10, "1P", "C", 6, "30mA", "A", 1.5, 1.5, "TPS", 36, "Surface conduit", 7, "A"),
    ],
  },
  {
    id: "DB-L2", name: "Level 2 distribution board", ref: "DB-L2", location: "L2 · electrical cupboard",
    suppliedFrom: "MSB · way 4 (sub-main)", supply: "1ph", voltage: 230, mainRating: 63, mainPoles: "2P",
    faultKA: 6, mainRcd: false, spd: true, ways: 12, status: "active",
    updated: "Today · 11:05", updatedBy: "An Bui · on site",
    circuits: [
      l2(1, "Lighting — open office", "lighting", "", "RCBO", 10, "1P", "C", 6, "30mA", "A", 1.5, 1.5, "TPS", 34, "Enclosed in ceiling", 7, "A"),
      l2(2, "Lighting — meeting rooms", "lighting", "", "RCBO", 10, "1P", "C", 6, "30mA", "A", 1.5, 1.5, "TPS", 41, "Enclosed in ceiling", 6, "A"),
      l2(3, "GPOs — open office east", "gpo", "", "RCBO", 20, "1P", "C", 6, "30mA", "A", 2.5, 2.5, "TPS", 28, "Enclosed in wall", 16, "A"),
      l2(4, "GPOs — open office west", "gpo", "", "RCBO", 20, "1P", "C", 6, "30mA", "A", 2.5, 2.5, "TPS", 33, "Enclosed in wall", 16, "A"),
      l2(5, "GPOs — kitchenette", "gpo", "", "MCB", 20, "1P", "C", 6, "none", "", 2.5, 2.5, "TPS", 24, "Enclosed in wall", 18, "A", "Flagged — MCB on GPO circuit"),
      l2(6, "A/C — FCU level 2", "ac", "", "RCBO", 16, "1P", "C", 6, "30mA", "A", 2.5, 2.5, "TPS", 30, "Surface conduit", 13, "A"),
      l2(7, "Hot water — kitchenette", "water", "", "MCB", 16, "1P", "C", 6, "none", "", 2.5, 2.5, "TPS", 26, "Enclosed in wall", 11, "A"),
    ],
  },
  {
    id: "DB-GF", name: "Ground floor board", ref: "DB-GF", location: "GF · reception store",
    suppliedFrom: "MSB · way 1 (sub-main)", supply: "1ph", voltage: 230, mainRating: 80, mainPoles: "2P",
    faultKA: 6, mainRcd: true, spd: true, ways: 18, status: "issued",
    updated: "12 Jun · 16:40", updatedBy: "Issued by Oskar Bühl",
    circuits: [
      gf(1, "Lighting — reception", "lighting", "", "RCBO", 10, "1P", "C", 6, "30mA", "A", 1.5, 1.5, "TPS", 22, "Enclosed in ceiling", 6, "A"),
      gf(2, "Lighting — retail tenancy", "lighting", "", "RCBO", 10, "1P", "C", 6, "30mA", "A", 1.5, 1.5, "TPS", 31, "Enclosed in ceiling", 8, "A"),
      gf(3, "GPOs — reception desk", "gpo", "", "RCBO", 20, "1P", "C", 6, "30mA", "A", 2.5, 2.5, "TPS", 18, "Enclosed in wall", 11, "A"),
      gf(4, "GPOs — retail tenancy", "gpo", "", "RCBO", 20, "1P", "C", 6, "30mA", "A", 2.5, 2.5, "TPS", 26, "Enclosed in wall", 11, "A"),
      gf(5, "EV charger — visitor bay", "ev", "", "RCBO", 32, "1P", "C", 6, "30mA", "B", 6, 6, "V90", 38, "Surface conduit", 32, "A"),
      gf(6, "Roller door + signage", "data", "", "RCBO", 16, "1P", "C", 6, "30mA", "A", 2.5, 2.5, "TPS", 20, "Surface conduit", 9, "A"),
    ],
  },
  {
    id: "DB-L4", name: "Level 4 board", ref: "DB-L4", location: "L4 · conference (rough-in)",
    suppliedFrom: "MSB · spare way (planned)", supply: "1ph", voltage: 230, mainRating: 63, mainPoles: "2P",
    faultKA: 6, mainRcd: false, spd: true, ways: 12, status: "draft",
    updated: "Not started", updatedBy: "—",
    circuits: [],
  },
];
