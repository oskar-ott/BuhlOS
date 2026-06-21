import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilCircuitSchedule } from "./PhilCircuitSchedule";
import type { Board, Circuit } from "@/domains/circuit-schedule/schema";

/**
 * SSR smoke for the Phil field circuit schedule — the boards-list render path
 * (the level-1 surface). Pins: honest-empty when there's no schedule, real board
 * + progress when there is, the Add affordance is present (P12 discoverable), and
 * a load error surfaces honestly (P7) rather than a blank screen (P8).
 */

function makeCircuit(install: string): Circuit {
  return {
    id: `c_${install}_${Math.random().toString(36).slice(2)}`,
    way: 1, desc: "GPOs", type: "gpo", phase: "A", device: "RCBO", rating: 20,
    poles: "1P", curve: "C", kA: 6, rcd: "30mA", rcdType: "A", active: 2.5,
    neut: 2.5, cores: "TPS", length: 10, method: "", load: 16, loadUnit: "A",
    notes: "", install,
  };
}

function makeBoard(name: string, installs: string[]): Board {
  return {
    id: `b_${name}`, name, ref: "DB-X", location: "L2 cupboard", suppliedFrom: "MSB",
    supply: "1ph", voltage: 230, mainRating: 63, mainPoles: "2P", faultKA: 6,
    mainRcd: false, spd: false, ways: 12, status: "active", updated: "", updatedBy: "",
    circuits: installs.map(makeCircuit),
  };
}

function render(props: Parameters<typeof PhilCircuitSchedule>[0]): string {
  return renderToString(createElement(PhilCircuitSchedule, props));
}

describe("PhilCircuitSchedule", () => {
  it("is honest-empty with no boards, and still offers Add board", () => {
    const html = render({ jobId: "j1", jobName: "Riverside", initialBoards: [], loadError: null });
    expect(html).toContain("No boards yet");
    expect(html).toContain("Add board");
  });

  it("lists a board with real install progress", () => {
    const html = render({
      jobId: "j1",
      jobName: "Riverside",
      initialBoards: [makeBoard("Level 2 board", ["installed", "tested", "todo"])],
      loadError: null,
    });
    expect(html).toContain("Level 2 board");
    expect(html).toContain("2/3 installed · 1 tested");
    expect(html).toContain("Add board");
  });

  it("surfaces a load error honestly instead of a blank screen", () => {
    const html = render({ jobId: "j1", jobName: "Riverside", initialBoards: [], loadError: "Couldn’t read the circuit schedule." });
    expect(html).toContain("Couldn’t read the circuit schedule.");
  });
});
