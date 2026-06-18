import { describe, expect, it } from "vitest";
import {
  boardTitle,
  circuitTypeLabel,
  deviceLabel,
  groupCircuitsByBoard,
  liveCircuitCount,
  sortByOrder,
  statusLabel,
  statusTone,
} from "./format";
import type { Circuit, Switchboard } from "./types";

function board(p: Partial<Switchboard> & { id: string; code: string }): Switchboard {
  return { ...p };
}
function circuit(p: Partial<Circuit> & { id: string; switchboardId: string }): Circuit {
  return { number: p.number ?? "C1", type: "power", status: "planned", ...p };
}

describe("circuit-schedule format labels", () => {
  it("maps known device / type / status values to display labels", () => {
    expect(deviceLabel("rcbo")).toBe("RCBO");
    expect(deviceLabel("rcd-mcb")).toBe("RCD + MCB");
    expect(circuitTypeLabel("light")).toBe("Lighting");
    expect(statusLabel("roughed-in")).toBe("Roughed in");
  });

  it("title-cases an unknown value instead of blanking it", () => {
    expect(deviceLabel("surge-protector")).toBe("Surge Protector");
    expect(statusLabel("decommissioned")).toBe("Decommissioned");
  });

  it("returns an empty string for blank/undefined", () => {
    expect(deviceLabel("")).toBe("");
    expect(deviceLabel(undefined)).toBe("");
  });

  it("tones the lifecycle from neutral → success", () => {
    expect(statusTone("planned")).toBe("neutral");
    expect(statusTone("roughed-in")).toBe("warning");
    expect(statusTone("energised")).toBe("info");
    expect(statusTone("commissioned")).toBe("success");
    expect(statusTone("nonsense")).toBe("neutral");
  });
});

describe("sortByOrder", () => {
  it("orders by explicit order then falls back to insertion index", () => {
    const rows = [
      { id: "a", order: 2 },
      { id: "b" }, // no order → after the ordered ones, keeps insertion slot
      { id: "c", order: 1 },
    ];
    expect(sortByOrder(rows).map((r) => r.id)).toEqual(["c", "a", "b"]);
  });
});

describe("groupCircuitsByBoard", () => {
  const boards = [
    board({ id: "sb1", code: "DB1", order: 1 }),
    board({ id: "sb2", code: "DB2", order: 0 }),
  ];
  const circuits = [
    circuit({ id: "c1", switchboardId: "sb1", order: 1 }),
    circuit({ id: "c2", switchboardId: "sb1", order: 0 }),
    circuit({ id: "c3", switchboardId: "sb2" }),
    circuit({ id: "orphan", switchboardId: "missing" }),
  ];

  it("groups circuits under their board, both ordered", () => {
    const groups = groupCircuitsByBoard(boards, circuits);
    expect(groups.map((g) => g.board.id)).toEqual(["sb2", "sb1"]);
    const sb1 = groups.find((g) => g.board.id === "sb1")!;
    expect(sb1.circuits.map((c) => c.id)).toEqual(["c2", "c1"]);
  });

  it("drops circuits whose board is not on the schedule", () => {
    const groups = groupCircuitsByBoard(boards, circuits);
    const all = groups.flatMap((g) => g.circuits.map((c) => c.id));
    expect(all).not.toContain("orphan");
  });

  it("excludes archived boards and circuits by default, includes on request", () => {
    const withArchived = [
      ...boards,
      board({ id: "sb3", code: "DB3", archived: true, order: 2 }),
    ];
    const circuitsArch = [
      ...circuits,
      circuit({ id: "old", switchboardId: "sb1", archived: true }),
    ];
    const live = groupCircuitsByBoard(withArchived, circuitsArch);
    expect(live.map((g) => g.board.id)).not.toContain("sb3");
    expect(live.flatMap((g) => g.circuits.map((c) => c.id))).not.toContain("old");

    const all = groupCircuitsByBoard(withArchived, circuitsArch, { includeArchived: true });
    expect(all.map((g) => g.board.id)).toContain("sb3");
  });

  it("counts only live circuits", () => {
    expect(liveCircuitCount(circuits)).toBe(4);
    expect(
      liveCircuitCount([...circuits, circuit({ id: "x", switchboardId: "sb1", archived: true })])
    ).toBe(4);
  });
});

describe("boardTitle", () => {
  it("appends a distinct name", () => {
    expect(boardTitle({ code: "DB1", name: "Kitchen board" })).toBe("DB1 — Kitchen board");
  });
  it("shows just the code when name is absent or identical", () => {
    expect(boardTitle({ code: "DB1" })).toBe("DB1");
    expect(boardTitle({ code: "DB1", name: "DB1" })).toBe("DB1");
  });
});
