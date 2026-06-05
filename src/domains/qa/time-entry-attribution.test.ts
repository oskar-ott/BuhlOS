import { describe, expect, it } from "vitest";

import {
  assertTimeEntryPostUsesExpectedJob,
  type AttributionCheckResult,
} from "./time-entry-attribution";

/**
 * Unit coverage for the Field-Readiness Smoke's hours-attribution rule
 * (the pure validator behind tests/playwright/helpers/fieldReadiness.ts).
 *
 * Preview Smoke proves the live Phil UI produces the expected request; these
 * tests lock the request-body contract — null / wrong / missing / malformed
 * job attribution — in normal CI so it cannot silently regress.
 */
const EXPECTED = "qa-seed-field-active-job";

/** The reason on a failing result ("" for ok), to keep matchers terse. */
function reasonOf(result: AttributionCheckResult): string {
  return result.ok ? "" : result.reason;
}

describe("assertTimeEntryPostUsesExpectedJob — accepts correct attribution", () => {
  it("passes a single allocation attributed to the expected job", () => {
    const result = assertTimeEntryPostUsesExpectedJob(
      { allocations: [{ jobId: EXPECTED }] },
      EXPECTED
    );
    expect(result.ok).toBe(true);
  });

  it("passes multiple allocations all attributed to the expected job", () => {
    const result = assertTimeEntryPostUsesExpectedJob(
      { allocations: [{ jobId: EXPECTED }, { jobId: EXPECTED }, { jobId: EXPECTED }] },
      EXPECTED
    );
    expect(result.ok).toBe(true);
  });

  it("ignores extra body/allocation fields as long as every jobId matches", () => {
    const result = assertTimeEntryPostUsesExpectedJob(
      { date: "2026-06-05", allocations: [{ jobId: EXPECTED, hours: 8, note: "x" }] },
      EXPECTED
    );
    expect(result.ok).toBe(true);
  });
});

describe("assertTimeEntryPostUsesExpectedJob — rejects bad job attribution", () => {
  it("fails when a jobId is null (the original #77 regression)", () => {
    const result = assertTimeEntryPostUsesExpectedJob({ allocations: [{ jobId: null }] }, EXPECTED);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/null/i);
  });

  it("fails when a jobId is missing", () => {
    const result = assertTimeEntryPostUsesExpectedJob({ allocations: [{ hours: 8 }] }, EXPECTED);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/null|empty/i);
  });

  it("fails when a jobId is an empty string", () => {
    const result = assertTimeEntryPostUsesExpectedJob({ allocations: [{ jobId: "" }] }, EXPECTED);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/null|empty/i);
  });

  it("fails an arbitrary different (truthy) jobId — the core Codex blocker", () => {
    const result = assertTimeEntryPostUsesExpectedJob(
      { allocations: [{ jobId: "some-other-job" }] },
      EXPECTED
    );
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/wrong job|expected/i);
    expect(reasonOf(result)).toContain("some-other-job");
  });

  it("fails a mixed batch: one correct, one wrong job", () => {
    const result = assertTimeEntryPostUsesExpectedJob(
      { allocations: [{ jobId: EXPECTED }, { jobId: "some-other-job" }] },
      EXPECTED
    );
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/wrong job|expected/i);
  });

  it("fails a mixed batch: one correct, one null job", () => {
    const result = assertTimeEntryPostUsesExpectedJob(
      { allocations: [{ jobId: EXPECTED }, { jobId: null }] },
      EXPECTED
    );
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/null/i);
  });
});

describe("assertTimeEntryPostUsesExpectedJob — rejects malformed bodies", () => {
  it("fails when allocations is missing", () => {
    const result = assertTimeEntryPostUsesExpectedJob({ date: "2026-06-05" }, EXPECTED);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/missing|allocations/i);
  });

  it("fails when allocations is an empty array", () => {
    const result = assertTimeEntryPostUsesExpectedJob({ allocations: [] }, EXPECTED);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/empty/i);
  });

  it("fails when allocations is not an array", () => {
    const result = assertTimeEntryPostUsesExpectedJob(
      { allocations: { jobId: EXPECTED } },
      EXPECTED
    );
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/array/i);
  });

  it("fails when an allocation is not an object", () => {
    const result = assertTimeEntryPostUsesExpectedJob({ allocations: ["nope"] }, EXPECTED);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/not an object/i);
  });

  it("fails when the body is null", () => {
    const result = assertTimeEntryPostUsesExpectedJob(null, EXPECTED);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/malformed/i);
  });

  it("fails when the body is not an object", () => {
    const result = assertTimeEntryPostUsesExpectedJob("nope", EXPECTED);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/malformed/i);
  });
});

describe("assertTimeEntryPostUsesExpectedJob — requires a concrete expected job", () => {
  it("fails when expectedJobId is an empty string", () => {
    const result = assertTimeEntryPostUsesExpectedJob({ allocations: [{ jobId: EXPECTED }] }, "");
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/expectedJobId|non-empty/i);
  });

  it("fails when expectedJobId is null or undefined", () => {
    for (const bad of [null, undefined]) {
      const result = assertTimeEntryPostUsesExpectedJob(
        { allocations: [{ jobId: EXPECTED }] },
        bad
      );
      expect(result.ok).toBe(false);
      expect(reasonOf(result)).toMatch(/expectedJobId|non-empty/i);
    }
  });
});
