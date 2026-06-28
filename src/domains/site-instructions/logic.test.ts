import { describe, expect, it } from "vitest";
import type { SiteInstruction } from "./schema";
import {
  awaitingSpawnCount,
  canTransitionInstruction,
  formatInstructionRef,
  isAwaitingSpawn,
  isInstructionTextFrozen,
  nextInstructionRef,
  parseInstructionRef,
  sortInstructionsForRegister,
} from "./logic";

function si(p: Partial<SiteInstruction> & { id: string }): SiteInstruction {
  return {
    jobId: "job1",
    ref: p.ref ?? "SI-001",
    instructedBy: { name: "Bob Builder", contactId: null, email: null },
    channel: "phone",
    instructionText: "move that GPO",
    dateReceived: "2026-06-01",
    status: "recorded",
    costTimeImplication: false,
    linkedRfiId: null,
    linkedVariationId: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    acknowledgementChannel: null,
    emailSentAt: null,
    closedAt: null,
    closedBy: null,
    closeReason: null,
    recordedBy: "admin1",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    auditLogIds: [],
    ...p,
  };
}

describe("instruction ref numbering", () => {
  it("formats a zero-padded SI ref", () => {
    expect(formatInstructionRef(1)).toBe("SI-001");
    expect(formatInstructionRef(42)).toBe("SI-042");
    expect(formatInstructionRef(1234)).toBe("SI-1234");
  });

  it("parses a well-formed ref and rejects junk", () => {
    expect(parseInstructionRef("SI-001")).toBe(1);
    expect(parseInstructionRef("SI-042")).toBe(42);
    expect(parseInstructionRef("SI-000")).toBeNull();
    expect(parseInstructionRef("RFI-001")).toBeNull();
    expect(parseInstructionRef("")).toBeNull();
    expect(parseInstructionRef("SI-")).toBeNull();
  });

  it("assigns SI-001 for an empty register", () => {
    expect(nextInstructionRef([])).toBe("SI-001");
  });

  it("assigns max-seen + 1, never a gap-fill", () => {
    // A deleted/closed SI-002 must NOT be reused — history would forge.
    expect(nextInstructionRef([{ ref: "SI-001" }, { ref: "SI-003" }])).toBe("SI-004");
  });

  it("ignores malformed refs when computing the next number", () => {
    expect(nextInstructionRef([{ ref: "SI-002" }, { ref: "junk" }, { ref: "SI-005" }])).toBe("SI-006");
  });
});

describe("instruction state machine", () => {
  it("allows recorded → acknowledged → closed and the verbal-only shortcut", () => {
    expect(canTransitionInstruction("recorded", "acknowledged")).toBe(true);
    expect(canTransitionInstruction("recorded", "closed")).toBe(true);
    expect(canTransitionInstruction("acknowledged", "closed")).toBe(true);
  });

  it("never goes backwards or out of closed", () => {
    expect(canTransitionInstruction("acknowledged", "recorded")).toBe(false);
    expect(canTransitionInstruction("closed", "acknowledged")).toBe(false);
    expect(canTransitionInstruction("closed", "recorded")).toBe(false);
    expect(canTransitionInstruction("recorded", "recorded")).toBe(false);
  });

  it("freezes the text once it leaves recorded", () => {
    expect(isInstructionTextFrozen("recorded")).toBe(false);
    expect(isInstructionTextFrozen("acknowledged")).toBe(true);
    expect(isInstructionTextFrozen("closed")).toBe(true);
  });
});

describe("awaiting-spawn attention", () => {
  it("flags a cost/time instruction with nothing spawned", () => {
    expect(isAwaitingSpawn(si({ id: "a", costTimeImplication: true }))).toBe(true);
  });

  it("clears once an RFI or a variation is linked", () => {
    expect(isAwaitingSpawn(si({ id: "a", costTimeImplication: true, linkedRfiId: "rfi_1" }))).toBe(false);
    expect(
      isAwaitingSpawn(si({ id: "a", costTimeImplication: true, linkedVariationId: "var_1" })),
    ).toBe(false);
  });

  it("is never flagged when unflagged or closed", () => {
    expect(isAwaitingSpawn(si({ id: "a", costTimeImplication: false }))).toBe(false);
    expect(isAwaitingSpawn(si({ id: "a", costTimeImplication: true, status: "closed" }))).toBe(false);
  });

  it("counts only the free-work-in-progress rows", () => {
    const list = [
      si({ id: "a", costTimeImplication: true }),
      si({ id: "b", costTimeImplication: true, linkedRfiId: "rfi_1" }),
      si({ id: "c", costTimeImplication: false }),
      si({ id: "d", costTimeImplication: true, status: "closed" }),
    ];
    expect(awaitingSpawnCount(list)).toBe(1);
  });
});

describe("register sort order", () => {
  it("puts flagged-but-unlinked rows first, then newest received", () => {
    const list = [
      si({ id: "old", ref: "SI-001", dateReceived: "2026-06-01" }),
      si({ id: "new", ref: "SI-002", dateReceived: "2026-06-10" }),
      si({ id: "risk", ref: "SI-003", dateReceived: "2026-05-01", costTimeImplication: true }),
    ];
    expect(sortInstructionsForRegister(list).map((x) => x.id)).toEqual(["risk", "new", "old"]);
  });

  it("does not mutate the input", () => {
    const list = [si({ id: "a", ref: "SI-001" }), si({ id: "b", ref: "SI-002" })];
    const out = sortInstructionsForRegister(list);
    expect(out).not.toBe(list);
    expect(list.map((x) => x.id)).toEqual(["a", "b"]);
  });
});
