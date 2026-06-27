import { describe, expect, it } from "vitest";
import { canTransition, isOverdue, nextReference, sortForRegister } from "./logic";
import type { Rfi } from "./schema";

const TODAY = "2026-06-28";

function rfi(over: Partial<Rfi> & Pick<Rfi, "id">): Rfi {
  return {
    jobId: "job-1",
    ref: "RFI-001",
    subject: "Q",
    question: "?",
    askedOf: "",
    status: "open",
    responseDue: "",
    sentAt: null,
    answer: "",
    answeredAt: null,
    answeredBy: null,
    closedReason: "",
    observationId: null,
    convertedFromObservationId: null,
    areaId: null,
    planId: null,
    raisedById: "u",
    raisedByName: "u",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    auditLogIds: [],
    ...over,
  };
}

describe("nextReference", () => {
  it("starts at RFI-001 and increments past the max, ignoring gaps + junk", () => {
    expect(nextReference([])).toBe("RFI-001");
    expect(nextReference([{ ref: "RFI-001" }, { ref: "RFI-002" }])).toBe("RFI-003");
    expect(nextReference([{ ref: "RFI-005" }, { ref: "junk" }])).toBe("RFI-006");
  });
});

describe("isOverdue", () => {
  it("is true only while awaiting an answer past the due date", () => {
    expect(isOverdue({ status: "open", responseDue: "2026-06-01" }, TODAY)).toBe(true);
    expect(isOverdue({ status: "sent", responseDue: "2026-06-30" }, TODAY)).toBe(false); // future
    expect(isOverdue({ status: "open", responseDue: "" }, TODAY)).toBe(false); // no due date
    expect(isOverdue({ status: "answered", responseDue: "2026-06-01" }, TODAY)).toBe(false);
    expect(isOverdue({ status: "closed", responseDue: "2026-06-01" }, TODAY)).toBe(false);
  });
});

describe("sortForRegister", () => {
  it("puts overdue first (most overdue first), then open/sent, answered, closed", () => {
    const list = [
      rfi({ id: "closed", status: "closed" }),
      rfi({ id: "overdue_mild", status: "open", responseDue: "2026-06-25" }),
      rfi({ id: "answered", status: "answered" }),
      rfi({ id: "overdue_bad", status: "sent", responseDue: "2026-06-10" }),
      rfi({ id: "open_future", status: "open", responseDue: "2026-07-10" }),
    ];
    expect(sortForRegister(list, TODAY).map((r) => r.id)).toEqual([
      "overdue_bad",
      "overdue_mild",
      "open_future",
      "answered",
      "closed",
    ]);
  });
  it("does not mutate the input", () => {
    const list = [rfi({ id: "a" }), rfi({ id: "b", status: "closed" })];
    sortForRegister(list, TODAY);
    expect(list.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("canTransition", () => {
  it("enforces the lifecycle", () => {
    expect(canTransition("open", "sent")).toBe(true);
    expect(canTransition("open", "answered")).toBe(true);
    expect(canTransition("sent", "answered")).toBe(true);
    expect(canTransition("answered", "closed")).toBe(true);
    expect(canTransition("closed", "open")).toBe(false);
    expect(canTransition("answered", "sent")).toBe(false);
  });
});
