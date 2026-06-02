import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Unit tests for the QA smoke-job classifier used by
 * scripts/qa/list-smoke-jobs.js. Pure logic (no blob IO) — loaded via
 * createRequire because the script is CommonJS. These lock the contract the
 * cleanup story depends on: every ACTIVE test job is flagged EXCEPT the one
 * documented stable fixture (QA_SEED_FIELD_ACTIVE_JOB).
 */
const requireFromHere = createRequire(import.meta.url);
const { QA_PREFIXES, ALLOWED_ACTIVE_FIXTURES, isQaTestJob, isAllowedActiveFixture, classify } =
  requireFromHere("../../../scripts/qa/list-smoke-jobs.js") as {
    QA_PREFIXES: string[];
    ALLOWED_ACTIVE_FIXTURES: string[];
    isQaTestJob: (name: unknown) => boolean;
    isAllowedActiveFixture: (name: unknown) => boolean;
    classify: (jobs: unknown) => {
      test: Array<{ id: string; status: string }>;
      active: Array<{ id: string }>;
      allowedActive: Array<{ id: string }>;
      disallowedActive: Array<{ id: string }>;
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

describe("isAllowedActiveFixture — only the stable field fixture may be Active", () => {
  it("allows exactly QA_SEED_FIELD_ACTIVE_JOB", () => {
    expect(ALLOWED_ACTIVE_FIXTURES).toEqual(["QA_SEED_FIELD_ACTIVE_JOB"]);
    expect(isAllowedActiveFixture("QA_SEED_FIELD_ACTIVE_JOB")).toBe(true);
  });
  it("does not allow generated smoke jobs or other QA_SEED_ jobs", () => {
    for (const name of [
      "SMOKE_TEST_1_Job_Builder",
      "STRESS_TEST_x",
      "QA_SEED_other",
      "QA_SEED_FIELD_ACTIVE_JOB_2",
      "",
    ]) {
      expect(isAllowedActiveFixture(name)).toBe(false);
    }
  });
});

describe("classify — flags every Active test job except the allowed fixture", () => {
  const jobs = [
    { id: "real-active", name: "Birdwood IV3232", status: "active" },
    { id: "smoke-active", name: "SMOKE_TEST_99_Job_Builder", status: "active" },
    { id: "smoke-draft", name: "SMOKE_TEST_98_Job_Builder", status: "draft" },
    { id: "fixture-active", name: "QA_SEED_FIELD_ACTIVE_JOB", status: "active" },
    { id: "seed-other-active", name: "QA_SEED_other", status: "active" },
    { id: "smoke-arch", name: "SMOKE_TEST_97_Job_Builder", status: "archived" },
  ];

  it("ignores real jobs; an Active SMOKE_TEST_ is disallowed", () => {
    const c = classify(jobs);
    expect(c.test.some((j) => j.id === "real-active")).toBe(false);
    expect(c.disallowedActive.map((j) => j.id).sort()).toEqual(
      ["seed-other-active", "smoke-active"].sort()
    );
  });

  it("a Draft SMOKE_TEST_ is fine (not active)", () => {
    expect(classify(jobs).disallowedActive.some((j) => j.id === "smoke-draft")).toBe(false);
    expect(classify(jobs).draft.map((j) => j.id)).toContain("smoke-draft");
  });

  it("an Active QA_SEED_FIELD_ACTIVE_JOB is allowed (not in the fail bucket)", () => {
    const c = classify(jobs);
    expect(c.allowedActive.map((j) => j.id)).toEqual(["fixture-active"]);
    expect(c.disallowedActive.some((j) => j.id === "fixture-active")).toBe(false);
  });

  it("an Active non-allowed QA_SEED_ job is disallowed", () => {
    expect(classify(jobs).disallowedActive.some((j) => j.id === "seed-other-active")).toBe(true);
  });

  it("clean state: only the allowed fixture is Active → no disallowed", () => {
    const clean = jobs.filter((j) => !["smoke-active", "seed-other-active"].includes(j.id));
    expect(classify(clean).disallowedActive).toEqual([]);
    expect(classify(clean).allowedActive.map((j) => j.id)).toEqual(["fixture-active"]);
  });

  it("tolerates non-array / empty input", () => {
    expect(classify(null).test).toEqual([]);
    expect(classify([]).disallowedActive).toEqual([]);
  });
});
