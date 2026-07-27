import { describe, expect, it } from "vitest";
import {
  CERTAINTY_STATES,
  CERTAINTY_LABEL,
  CertaintyStateSchema,
  isFieldEligible,
  needsTriage,
  isResolved,
  isRfi,
  availableTransitions,
  canTransition,
  transition,
} from "./certainty";

describe("certainty states", () => {
  it("is the closed six-state enum, in lifecycle order", () => {
    expect(CERTAINTY_STATES).toEqual([
      "suggested",
      "needs_review",
      "confirmed",
      "converted",
      "ignored",
      "rfi",
    ]);
  });

  it("gives every state fixed wording", () => {
    for (const s of CERTAINTY_STATES) expect(CERTAINTY_LABEL[s]).toBeTruthy();
  });

  it("schema accepts every state and rejects the prototype's old `review` spelling", () => {
    for (const s of CERTAINTY_STATES) expect(CertaintyStateSchema.parse(s)).toBe(s);
    expect(CertaintyStateSchema.safeParse("review").success).toBe(false);
  });
});

describe("predicates", () => {
  it("makes only confirmed/converted field-eligible", () => {
    expect(CERTAINTY_STATES.filter(isFieldEligible)).toEqual(["confirmed", "converted"]);
  });

  it("flags suggested + needs_review for triage, but not rfi", () => {
    expect(CERTAINTY_STATES.filter(needsTriage)).toEqual(["suggested", "needs_review"]);
    expect(needsTriage("rfi")).toBe(false);
  });

  it("counts confirmed/converted/ignored as resolved, but not rfi (acknowledged ≠ answered)", () => {
    expect(CERTAINTY_STATES.filter(isResolved)).toEqual(["confirmed", "converted", "ignored"]);
    expect(isResolved("rfi")).toBe(false);
  });

  it("treats rfi alone as the explicit unknown", () => {
    expect(CERTAINTY_STATES.filter(isRfi)).toEqual(["rfi"]);
  });
});

describe("transition machine", () => {
  it("never auto-converts: `converted` is reachable only from `confirmed`", () => {
    for (const s of CERTAINTY_STATES) {
      if (s === "confirmed") expect(availableTransitions(s)).toContain("converted");
      else expect(availableTransitions(s)).not.toContain("converted");
    }
  });

  it("forbids a direct suggested → converted move", () => {
    expect(canTransition("suggested", "converted")).toBe(false);
  });

  it("treats a no-op (same state) as not a transition", () => {
    for (const s of CERTAINTY_STATES) expect(canTransition(s, s)).toBe(false);
  });

  it("lets any other state be pulled back to needs_review", () => {
    for (const s of CERTAINTY_STATES) {
      if (s !== "needs_review") expect(canTransition(s, "needs_review")).toBe(true);
    }
  });

  it("returns the target on a legal move", () => {
    expect(transition("needs_review", "confirmed")).toBe("confirmed");
    expect(transition("confirmed", "converted")).toBe("converted");
    expect(transition("suggested", "ignored")).toBe("ignored");
  });

  it("throws on an illegal move", () => {
    expect(() => transition("suggested", "converted")).toThrow(/Illegal certainty transition/);
    expect(() => transition("ignored", "rfi")).toThrow();
  });

  it("only ever lists valid states as targets", () => {
    for (const s of CERTAINTY_STATES) {
      for (const t of availableTransitions(s)) expect(CERTAINTY_STATES).toContain(t);
    }
  });
});
