import { describe, expect, it } from "vitest";
import {
  HoursPolicySchema,
  JobTypesSchema,
  PolicyPutSchema,
  validateDailyThreshold,
  validateJobTypeName,
} from "./policy-schema";

/**
 * #222 — the advisory policy/job-types schemas must mirror the server bounds
 * exactly: `api/policy.js` accepts a finite number in [1, 24]; `api/job-types.js`
 * stores `{ jobTypes: [{ id, name }] }`. These tests pin the accept/reject edges
 * so the form never sends a value the API will 400 (and never blocks one it
 * would accept).
 */

describe("HoursPolicySchema / validateDailyThreshold", () => {
  it("accepts 9 (the default threshold)", () => {
    expect(HoursPolicySchema.safeParse({ dailyThreshold: 9 }).success).toBe(true);
    const r = validateDailyThreshold(9);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(9);
  });

  it("accepts the inclusive bounds 1 and 24", () => {
    expect(validateDailyThreshold(1).ok).toBe(true);
    expect(validateDailyThreshold(24).ok).toBe(true);
  });

  it("rejects 0 (below the minimum)", () => {
    const r = validateDailyThreshold(0);
    expect(r.ok).toBe(false);
  });

  it("rejects 25 (above the maximum)", () => {
    const r = validateDailyThreshold(25);
    expect(r.ok).toBe(false);
  });

  it("rejects a non-number", () => {
    expect(validateDailyThreshold("nine").ok).toBe(false);
    expect(validateDailyThreshold(null).ok).toBe(false);
    expect(validateDailyThreshold(undefined).ok).toBe(false);
  });

  it("rejects NaN / Infinity (must be finite)", () => {
    expect(validateDailyThreshold(Number.NaN).ok).toBe(false);
    expect(validateDailyThreshold(Number.POSITIVE_INFINITY).ok).toBe(false);
  });

  it("rejects a missing field", () => {
    expect(HoursPolicySchema.safeParse({}).success).toBe(false);
    expect(PolicyPutSchema.safeParse({}).success).toBe(false);
    expect(PolicyPutSchema.safeParse({ hours: { dailyThreshold: 9 } }).success).toBe(true);
  });
});

describe("JobTypesSchema / validateJobTypeName", () => {
  it("accepts a well-formed collection", () => {
    const r = JobTypesSchema.safeParse({
      jobTypes: [
        { id: "jt_1", name: "Domestic" },
        { id: "jt_2", name: "Commercial" },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("accepts an empty collection (a real, non-error state)", () => {
    expect(JobTypesSchema.safeParse({ jobTypes: [] }).success).toBe(true);
  });

  it("rejects an entry missing an id or name", () => {
    expect(JobTypesSchema.safeParse({ jobTypes: [{ id: "", name: "X" }] }).success).toBe(false);
    expect(JobTypesSchema.safeParse({ jobTypes: [{ id: "jt_1", name: "" }] }).success).toBe(false);
  });

  it("accepts a trimmed non-empty name and rejects blank/whitespace", () => {
    const ok = validateJobTypeName("  Domestic  ");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value).toBe("Domestic");
    expect(validateJobTypeName("   ").ok).toBe(false);
    expect(validateJobTypeName("").ok).toBe(false);
    expect(validateJobTypeName(123).ok).toBe(false);
  });
});
