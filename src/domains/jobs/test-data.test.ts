import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { QA_TEST_JOB_PREFIXES, isQaTestJobName, isDeletableTestJob } from "./test-data";

/**
 * Parity lock between the TS mirror (src/domains/jobs/test-data.ts — admin
 * UI display/gating) and the CJS source of truth (api/_lib/test-data.js —
 * the DELETE /api/jobs guard + QA scripts). The constants are deliberately
 * duplicated across the api/src boundary; these tests are what make that
 * duplication safe. If either side changes alone, this suite fails.
 */
const requireFromHere = createRequire(import.meta.url);
const server = requireFromHere("../../../api/_lib/test-data.js") as {
  QA_PREFIXES: string[];
  isQaTestJob: (name: unknown) => boolean;
  testJobDeleteEligibility: (job: unknown) => { ok: boolean; reason?: string };
};

describe("test-data TS mirror stays in sync with api/_lib/test-data.js", () => {
  it("pins the QA prefixes to the same values", () => {
    expect([...QA_TEST_JOB_PREFIXES]).toEqual(server.QA_PREFIXES);
  });

  it("isQaTestJobName matches the server predicate", () => {
    const samples = [
      "SMOKE_TEST_123_Job_Builder",
      "STRESS_TEST_load",
      "QA_SEED_FIELD_ACTIVE_JOB",
      "Birdwood IV3232",
      "smoke_test_lowercase",
      "",
    ];
    for (const name of samples) {
      expect(isQaTestJobName(name)).toBe(server.isQaTestJob(name));
    }
  });

  it("isDeletableTestJob matches testJobDeleteEligibility across the matrix", () => {
    const names = ["SMOKE_TEST_1_Job_Builder", "QA_SEED_FIELD_ACTIVE_JOB", "Real Job"];
    const statuses = ["draft", "active", "archived", "complete", "on_hold", undefined];
    for (const name of names) {
      for (const status of statuses) {
        const job = { name, status };
        expect(isDeletableTestJob(job)).toBe(server.testJobDeleteEligibility(job).ok);
      }
    }
  });

  it("only explicitly parked (draft/archived) test jobs are deletable", () => {
    expect(isDeletableTestJob({ name: "SMOKE_TEST_1_Job_Builder", status: "draft" })).toBe(true);
    expect(isDeletableTestJob({ name: "SMOKE_TEST_1_Job_Builder", status: "archived" })).toBe(true);
    expect(isDeletableTestJob({ name: "SMOKE_TEST_1_Job_Builder", status: "active" })).toBe(false);
    // Missing status = legacy create-then-live = field-visible: not deletable.
    expect(isDeletableTestJob({ name: "SMOKE_TEST_1_Job_Builder" })).toBe(false);
    expect(isDeletableTestJob({ name: "QA_SEED_FIELD_ACTIVE_JOB", status: "active" })).toBe(false);
    expect(isDeletableTestJob({ name: "Real Client Fitout", status: "draft" })).toBe(false);
  });
});
