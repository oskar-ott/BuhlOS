import { describe, expect, it } from "vitest";

import { assertTimeEntryPostUsesExpectedJob } from "./time-entry-attribution";

/**
 * Unit coverage for the pure attribution validator extracted from the
 * Field-Readiness Smoke (tests/playwright/helpers/fieldReadiness.ts).
 *
 * The credentialed Preview Smoke only EXERCISES this logic against a live
 * preview; normal CI (the `check` workflow) used to merely typecheck the inline
 * version. These tests run it for real in plain vitest — the six cases Codex
 * asked for on PR #80, plus the partial-null and return-value nuances the
 * contract hinges on.
 */
describe("assertTimeEntryPostUsesExpectedJob", () => {
  const JOB = "QA_SEED_FIELD_ACTIVE_JOB-id";

  // (1) valid passes — and returns the attributed jobId.
  it("accepts a body whose allocations all carry the expected jobId", () => {
    expect(
      assertTimeEntryPostUsesExpectedJob({ allocations: [{ jobId: JOB }] }, JOB),
    ).toBe(JOB);
  });

  // (2) jobId:null fails.
  it("rejects an allocation with jobId:null", () => {
    expect(() =>
      assertTimeEntryPostUsesExpectedJob({ allocations: [{ jobId: null }] }),
    ).toThrow(/non-null jobId/);
  });

  // (3) a different (arbitrary truthy) jobId fails when an expected id is given.
  it("rejects an allocation attributed to some other job", () => {
    expect(() =>
      assertTimeEntryPostUsesExpectedJob(
        { allocations: [{ jobId: "some-other-job" }] },
        JOB,
      ),
    ).toThrow(/attribute to the assigned job/);
  });

  // (4) missing allocations fails.
  it("rejects a body with no allocations field", () => {
    expect(() => assertTimeEntryPostUsesExpectedJob({})).toThrow(
      /non-empty allocations array/,
    );
  });

  // (5) empty allocations fails.
  it("rejects an empty allocations array", () => {
    expect(() =>
      assertTimeEntryPostUsesExpectedJob({ allocations: [] }),
    ).toThrow(/non-empty allocations array/);
  });

  // (6) non-array allocations fails.
  it("rejects a non-array allocations value", () => {
    expect(() =>
      assertTimeEntryPostUsesExpectedJob({ allocations: "nope" }),
    ).toThrow(/non-empty allocations array/);
  });

  // Nuances the contract turns on (beyond the six base cases).
  describe("contract nuances", () => {
    // A partial-null must NOT slip through a naive "first truthy jobId" search.
    it("rejects a partial-null allocation list [{null},{real}]", () => {
      expect(() =>
        assertTimeEntryPostUsesExpectedJob({
          allocations: [{ jobId: null }, { jobId: JOB }],
        }),
      ).toThrow(/non-null jobId/);
    });

    // EVERY allocation must equal the expected job, not just the first.
    it("rejects when a later allocation attributes to a different job", () => {
      expect(() =>
        assertTimeEntryPostUsesExpectedJob(
          { allocations: [{ jobId: JOB }, { jobId: "other" }] },
          JOB,
        ),
      ).toThrow(/attribute to the assigned job/);
    });

    // With no expectedJobId, any consistent truthy jobId is accepted.
    it("accepts a truthy jobId when no expected id is supplied", () => {
      expect(
        assertTimeEntryPostUsesExpectedJob({ allocations: [{ jobId: JOB }] }),
      ).toBe(JOB);
    });

    // Multiple allocations all matching the expected job pass.
    it("accepts multiple allocations that all match the expected job", () => {
      expect(
        assertTimeEntryPostUsesExpectedJob(
          { allocations: [{ jobId: JOB }, { jobId: JOB }] },
          JOB,
        ),
      ).toBe(JOB);
    });

    // A null/undefined body is treated as a missing allocations array.
    it("rejects a null body", () => {
      expect(() => assertTimeEntryPostUsesExpectedJob(null)).toThrow(
        /non-empty allocations array/,
      );
    });
  });
});
