import { describe, expect, it } from "vitest";
import {
  rowCurrent,
  rowVd,
  rcdRequired,
  hasRcd,
  rowWarnings,
  phaseLoads,
  balance,
  totals,
  autoBalance,
  fromPreset,
} from "./compute";
import { type Board, type Circuit, PRESETS, VD_LIMIT } from "./schema";
import { SAMPLE_BOARDS } from "./sample-boards";

const boardById = (id: string): Board => SAMPLE_BOARDS.find((b) => b.id === id)!;

// minimal circuit factory for synthetic cases
function circuit(over: Partial<Circuit>): Circuit {
  return {
    id: over.id ?? "t1", way: 1, desc: "", type: "gpo", phase: "A", device: "RCBO",
    rating: 20, poles: "1P", curve: "C", kA: 6, rcd: "30mA", rcdType: "A",
    active: 2.5, neut: 2.5, cores: "TPS", length: 10, method: "", load: 10,
    loadUnit: "A", notes: "", ...over,
  };
}

describe("rowCurrent", () => {
  it("passes amp loads through", () => {
    expect(rowCurrent(circuit({ load: 16, loadUnit: "A" }))).toBe(16);
  });
  it("converts kW at single-phase 0.95 PF", () => {
    expect(rowCurrent(circuit({ load: 2.3, loadUnit: "kW", poles: "1P" }))).toBeCloseTo(10.53, 1);
  });
  it("converts kW at three-phase 0.85 PF", () => {
    expect(rowCurrent(circuit({ load: 10, loadUnit: "kW", poles: "3P" }))).toBeCloseTo(16.98, 1);
  });
});

describe("rowVd", () => {
  it("computes single-phase voltage drop from the mV/A/m table", () => {
    // 16 A on 2.5 mm² (17.6 mV/A/m) over 52 m → ~6.37 %
    const vd = rowVd(circuit({ load: 16, active: 2.5, length: 52, poles: "1P" }));
    expect(vd).toBeCloseTo(6.37, 1);
    expect(vd).toBeGreaterThan(VD_LIMIT);
  });
  it("a short run stays well under the limit", () => {
    expect(rowVd(circuit({ load: 10, active: 2.5, length: 8 }))).toBeLessThan(VD_LIMIT);
  });
  it("the sample long comms run is flagged over the limit", () => {
    const c = boardById("MSB-100").circuits.find((x) => x.way === 22)!;
    expect(rowVd(c)).toBeGreaterThan(VD_LIMIT);
  });
});

describe("RCD rule", () => {
  it("a GPO final subcircuit requires RCD; an MCB without RCD is missing it", () => {
    const mcbGpo = circuit({ type: "gpo", device: "MCB", rcd: "none", rcdType: "" });
    expect(rcdRequired(mcbGpo)).toBe(true);
    expect(hasRcd(mcbGpo)).toBe(false);
    const warns = rowWarnings(mcbGpo);
    expect(warns.some((w) => w.code === "RCD" && w.sev === "red")).toBe(true);
  });
  it("a sub-main does not require RCD", () => {
    expect(rcdRequired(circuit({ type: "submain", device: "MCCB", rcd: "none" }))).toBe(false);
  });
  it("an RCBO is treated as having RCD", () => {
    expect(hasRcd(circuit({ device: "RCBO", rcd: "30mA" }))).toBe(true);
  });
  it("the sample MCB-on-GPO row surfaces an RCD error", () => {
    const c = boardById("DB-L2").circuits.find((x) => x.way === 5)!;
    expect(rowWarnings(c).some((w) => w.code === "RCD")).toBe(true);
  });
});

describe("rowWarnings — cable capacity", () => {
  it("flags a device rating that exceeds the conductor capacity", () => {
    // 40 A device on 2.5 mm² (cap 25 A)
    const warns = rowWarnings(circuit({ type: "submain", rating: 40, active: 2.5 }));
    expect(warns.some((w) => w.code === "CSA" && w.sev === "red")).toBe(true);
  });
});

describe("phaseLoads & balance", () => {
  it("3-phase circuits load all three phases; single-phase land on their phase", () => {
    const b: Board = {
      ...boardById("DB-L4"),
      supply: "3ph",
      circuits: [
        circuit({ id: "x", poles: "3P", load: 30 }),
        circuit({ id: "y", poles: "1P", phase: "B", load: 10 }),
      ],
    };
    const p = phaseLoads(b);
    expect(p.A).toBe(30);
    expect(p.B).toBe(40);
    expect(p.C).toBe(30);
  });
  it("balance is null for single-phase boards", () => {
    expect(balance(boardById("DB-L2"))).toBeNull();
  });
  it("balance is computed for a 3-phase board", () => {
    const b = balance(boardById("MSB-100"));
    expect(b).not.toBeNull();
    expect(["ok", "caution", "bad"]).toContain(b!.status);
  });
});

describe("totals", () => {
  it("counts ways used and spare", () => {
    const t = totals(boardById("DB-L2"));
    expect(t.used).toBe(7);
    expect(t.spare).toBe(12 - 7);
  });
  it("an empty board is clean with full spare capacity", () => {
    const t = totals(boardById("DB-L4"));
    expect(t).toMatchObject({ used: 0, spare: 12, connected: 0, overloaded: false, errCount: 0, warnCount: 0 });
  });
  it("flags an overloaded board (raw connected load over the main rating)", () => {
    const t = totals(boardById("DB-L2")); // ~87 A raw vs 63 A main
    expect(t.overloaded).toBe(true);
    expect(t.connected).toBeGreaterThan(63);
  });
});

describe("autoBalance", () => {
  const base = boardById("DB-L4");
  const lopsided: Board = {
    ...base,
    supply: "3ph",
    circuits: [
      circuit({ id: "a", poles: "1P", phase: "A", load: 30 }),
      circuit({ id: "b", poles: "1P", phase: "A", load: 20 }),
      circuit({ id: "c", poles: "1P", phase: "A", load: 10 }),
      circuit({ id: "d", poles: "3P", load: 15 }),
    ],
  };

  it("reduces imbalance without mutating the input", () => {
    const before = balance(lopsided)!.imb;
    const out = autoBalance(lopsided);
    const after = balance(out)!.imb;
    expect(after).toBeLessThan(before);
    // input untouched (immutability)
    expect(lopsided.circuits.every((c) => c.phase === "A" || c.poles === "3P")).toBe(true);
    expect(lopsided.circuits[0]!.phase).toBe("A");
  });

  it("spreads the single-phase circuits across L1/L2/L3", () => {
    const out = autoBalance(lopsided);
    const singles = out.circuits.filter((c) => c.poles !== "3P");
    expect(new Set(singles.map((c) => c.phase)).size).toBe(3);
  });

  it("leaves 3-phase circuits' phase untouched", () => {
    const out = autoBalance(lopsided);
    expect(out.circuits.find((c) => c.id === "d")!.poles).toBe("3P");
  });
});

describe("fromPreset", () => {
  it("builds a circuit carrying the preset's device + cable defaults at the given way", () => {
    const gpo = PRESETS.find((p) => p.key === "gpo")!;
    const c = fromPreset(gpo, 7);
    expect(c).toMatchObject({
      way: 7, type: "gpo", device: "RCBO", rating: 20, poles: "1P",
      active: 2.5, cores: "TPS", phase: "A",
    });
    expect(c.id).toMatch(/^c\d+$/);
  });
});
