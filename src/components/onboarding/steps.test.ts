import { describe, expect, it } from "vitest";
import { STEPS, TOTAL_STEPS, getStepMeta, isStepId, nextStep } from "./steps";

describe("onboarding step taxonomy", () => {
  it("declares nine total stages with eight numbered steps", () => {
    expect(STEPS).toHaveLength(9);
    const numbered = STEPS.filter((s) => s.number !== null);
    expect(numbered.map((s) => s.number)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(TOTAL_STEPS).toBe(8);
  });

  it("disallows skip on welcome / identity / ready", () => {
    const noSkip = STEPS.filter((s) => !s.skippable).map((s) => s.id);
    expect(noSkip).toEqual(["welcome", "identity", "ready"]);
  });

  it("recognises valid step IDs and rejects others", () => {
    expect(isStepId("welcome")).toBe(true);
    expect(isStepId("hours")).toBe(true);
    expect(isStepId("ready")).toBe(true);
    expect(isStepId("nope")).toBe(false);
    expect(isStepId(null)).toBe(false);
    expect(isStepId(undefined)).toBe(false);
  });

  it("returns metadata for each step", () => {
    expect(getStepMeta("welcome").number).toBeNull();
    expect(getStepMeta("identity").number).toBe(2);
    expect(getStepMeta("permissions").number).toBe(8);
    expect(getStepMeta("ready").number).toBeNull();
  });

  it("advances through the flow in order, terminating at ready", () => {
    expect(nextStep("welcome")).toBe("identity");
    expect(nextStep("identity")).toBe("hours");
    expect(nextStep("hours")).toBe("gear");
    expect(nextStep("gear")).toBe("jobs");
    expect(nextStep("jobs")).toBe("job-interface");
    expect(nextStep("job-interface")).toBe("site-data");
    expect(nextStep("site-data")).toBe("permissions");
    expect(nextStep("permissions")).toBe("ready");
    expect(nextStep("ready")).toBe("ready");
  });
});
