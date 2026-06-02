import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Unit tests for the QA smoke-job classifier used by
 * scripts/qa/list-smoke-jobs.js. Pure logic (no blob IO) — loaded via
 * createRequire because the script is CommonJS. These lock the contract the
 * cleanup story depends on: any ACTIVE test job must be detectable.
 */
const requireFromHere = createRequire(import.meta.url);
const { QA_PREFIXES, isQaTestJob, classify } = requireFromHere(
  "../../../scripts/qa/list-smoke-jobs.js"
) as {
  QA_PREFIXES: string[];
  isQaTestJob: (name: unknown) => boolean;
  classify: (jobs: unknown) => {
    test: Array<{ id: string; status: string }>;
    active: Array<{ id: string }>;
    draft: Array<{ id: string }>;
    archived: Array<{ id: string }>;
    other: Array<{ id: string }>;
  };
};

describe("isQaTestJob — prefix detection", () => {
  it("matches the documented QA/test prefixes", () => {
    expect(QA_PREFIXES).toEqual(["SMOKE_TEST_", "STRESS_TEST_", "QA_SEED_"]);
    expect(isQaTestJob("SMOKE_TEST_123_Job_Builder")).toBe(true);
    expect(isQaTestJob("STRESS_TEST_load")).toBe(true);
    expect(isQaTestJob("QA_SEED_Birdwood_Field_Test")).toBe(true);
  });

  it("does not match real jobs, case-mismatches, or empty names", () => {
    for (const name of [
      "Birdwood IV3232",
      "smoke_test_lowercase", // case-sensitive on purpose
      "Job SMOKE_TEST_ in the middle",
      "",
      undefined,
      null,
    ]) {
      expect(isQaTestJob(name)).toBe(false);
    }
  });
});

describe("classify — buckets test jobs by status, isolates Active", () => {
  const jobs = [
    { id: "real-1", name: "Birdwood IV3232", status: "active" },
    { id: "smoke-active", name: "SMOKE_TEST_99_Job_Builder", status: "active" },
    { id: "smoke-draft", name: "SMOKE_TEST_98_Job_Builder", status: "draft" },
    { id: "seed-draft", name: "QA_SEED_Field_Test", status: "draft" },
    { id: "smoke-arch", name: "SMOKE_TEST_97_Job_Builder", status: "archived" },
    { id: "smoke-weird", name: "STRESS_TEST_x", status: "queued" },
  ];

  it("ignores non-test jobs and groups test jobs by status", () => {
    const c = classify(jobs);
    expect(c.test.map((j) => j.id).sort()).toEqual(
      ["seed-draft", "smoke-active", "smoke-arch", "smoke-draft", "smoke-weird"].sort()
    );
    expect(c.test.some((j) => j.id === "real-1")).toBe(false);
    expect(c.active.map((j) => j.id)).toEqual(["smoke-active"]);
    expect(c.draft.map((j) => j.id).sort()).toEqual(["seed-draft", "smoke-draft"].sort());
    expect(c.archived.map((j) => j.id)).toEqual(["smoke-arch"]);
    expect(c.other.map((j) => j.id)).toEqual(["smoke-weird"]);
  });

  it("returns an empty Active bucket when no test job is active (the clean state)", () => {
    const clean = classify(jobs.filter((j) => j.id !== "smoke-active"));
    expect(clean.active).toEqual([]);
  });

  it("tolerates non-array / empty input", () => {
    expect(classify(null).test).toEqual([]);
    expect(classify([]).active).toEqual([]);
  });
});
