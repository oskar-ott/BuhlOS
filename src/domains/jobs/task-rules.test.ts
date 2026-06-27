import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { validateRules, type TaskRule } from "./task-rules";

/**
 * #224 — the generation engine lives in CJS (api/_lib/task-rules.js) as the
 * single source of truth shared by both handlers; we require it here so the
 * table-driven behaviour is pinned in one place. The TS validateRules (advisory
 * UI check) is tested directly.
 */
type Task = { id: string; name: string };
type Area = { id: string; name: string; roughInTasks?: Task[]; fitOffTasks?: Task[]; archived?: boolean };
type Group = { id: string; name: string; areas: Area[] };

const requireFromHere = createRequire(import.meta.url);
const engine = requireFromHere("../../../api/_lib/task-rules.js") as {
  ruleMatchesArea: (rule: TaskRule, jobType: string | null, areaName: string) => boolean;
  matchedTaskNames: (
    rules: TaskRule[],
    jobType: string | null,
    areaName: string
  ) => { roughIn: string[]; fitOff: string[]; matched: boolean };
  generateTasksForJob: (
    job: unknown,
    rules: TaskRule[],
    opts?: { mode?: string; newId?: (name: string, i: number) => string }
  ) => { areaGroups: Group[]; summary: Record<string, number> };
  normaliseRules: (
    incoming: unknown,
    nanoid: (p: string) => string
  ) => { rules?: TaskRule[]; error?: string };
};
const { ruleMatchesArea, matchedTaskNames, generateTasksForJob, normaliseRules } = engine;

const rule = (over: Partial<TaskRule>): TaskRule => ({
  id: over.id ?? "r1",
  jobType: over.jobType ?? null,
  areaPattern: over.areaPattern ?? null,
  roughIn: over.roughIn ?? [],
  fitOff: over.fitOff ?? [],
});

// Deterministic id factory so output is fully assertable.
const ids = () => {
  let n = 0;
  return (name: string) => `id_${n++}_${name.replace(/\s+/g, "-").toLowerCase()}`;
};

describe("ruleMatchesArea", () => {
  it.each([
    ["wildcard rule matches anything", { jobType: null, areaPattern: null }, "t_resi", "Kitchen", true],
    ["jobType match", { jobType: "t_resi", areaPattern: null }, "t_resi", "Kitchen", true],
    ["jobType mismatch", { jobType: "t_resi", areaPattern: null }, "t_comm", "Kitchen", false],
    ["area substring (case-insensitive)", { jobType: null, areaPattern: "bath" }, "t_resi", "Main Bathroom", true],
    ["area substring miss", { jobType: null, areaPattern: "bath" }, "t_resi", "Kitchen", false],
    ["both conditions — area fails", { jobType: "t_resi", areaPattern: "bath" }, "t_resi", "Kitchen", false],
    ["both conditions hold", { jobType: "t_resi", areaPattern: "bath" }, "t_resi", "Ensuite Bathroom", true],
    ["empty-string conditions wildcard", { jobType: "", areaPattern: "" }, null, "Anything", true],
  ] as const)("%s", (_label, conds, jobType, areaName, expected) => {
    expect(ruleMatchesArea(rule(conds), jobType, areaName)).toBe(expected);
  });
});

describe("matchedTaskNames", () => {
  it("unions task names across matching rules, deduped, in rule then task order", () => {
    const rules = [
      rule({ id: "a", areaPattern: "bath", roughIn: ["Rough A", "Shared"], fitOff: ["Fit A"] }),
      rule({ id: "b", areaPattern: null, roughIn: ["Shared", "Rough B"], fitOff: ["Fit B"] }),
    ];
    const r = matchedTaskNames(rules, "t_resi", "Main Bathroom");
    expect(r.matched).toBe(true);
    expect(r.roughIn).toEqual(["Rough A", "Shared", "Rough B"]); // dedup "Shared"
    expect(r.fitOff).toEqual(["Fit A", "Fit B"]);
  });

  it("reports no match when nothing applies", () => {
    const r = matchedTaskNames([rule({ areaPattern: "bath", roughIn: ["x"] })], "t_resi", "Kitchen");
    expect(r.matched).toBe(false);
    expect(r.roughIn).toEqual([]);
  });

  it("drops blank/whitespace names", () => {
    const r = matchedTaskNames([rule({ areaPattern: null, roughIn: ["  ", "Real", ""] })], null, "X");
    expect(r.roughIn).toEqual(["Real"]);
  });
});

describe("generateTasksForJob — fill-empty (default)", () => {
  const rules = [
    rule({ areaPattern: "bath", roughIn: ["Rough-in points", "Run cable"], fitOff: ["Fit GPOs"] }),
  ];
  const base = {
    type: "t_resi",
    areaGroups: [
      {
        id: "g1",
        name: "Level 1",
        areas: [
          { id: "a1", name: "Main Bathroom" }, // empty → filled
          { id: "a2", name: "Kitchen" }, // no match → untouched
        ],
      },
    ],
  };

  it("fills an empty matching area and leaves non-matching ones alone", () => {
    const { areaGroups, summary } = generateTasksForJob(base, rules, { newId: ids() });
    const areas = areaGroups[0]!.areas;
    const bath = areas.find((a) => a.id === "a1")!;
    const kitchen = areas.find((a) => a.id === "a2")!;
    expect(bath.roughInTasks!.map((t) => t.name)).toEqual(["Rough-in points", "Run cable"]);
    expect(bath.fitOffTasks!.map((t) => t.name)).toEqual(["Fit GPOs"]);
    expect(kitchen.roughInTasks ?? []).toEqual([]); // untouched
    expect(summary).toEqual({
      areasMatched: 1,
      areasFilled: 1,
      roughInAdded: 2,
      fitOffAdded: 1,
      areasSkippedNonEmpty: 0,
    });
  });

  it("never overwrites a non-empty stage list in fill-empty mode", () => {
    const withExisting = {
      type: "t_resi",
      areaGroups: [
        {
          id: "g1",
          name: "L1",
          areas: [{ id: "a1", name: "Main Bathroom", roughInTasks: [{ id: "keep", name: "Existing" }] }],
        },
      ],
    };
    const { areaGroups, summary } = generateTasksForJob(withExisting, rules, { newId: ids() });
    const bath = areaGroups[0]!.areas[0]!;
    expect(bath.roughInTasks!.map((t) => t.name)).toEqual(["Existing"]); // non-empty kept
    expect(bath.fitOffTasks!.map((t) => t.name)).toEqual(["Fit GPOs"]); // empty filled
    expect(summary.roughInAdded).toBe(0);
    expect(summary.fitOffAdded).toBe(1);
  });

  it("counts a fully non-empty matching area as skipped, not filled", () => {
    const full = {
      type: "t_resi",
      areaGroups: [
        {
          id: "g1",
          name: "L1",
          areas: [
            { id: "a1", name: "Main Bathroom", roughInTasks: [{ id: "k1", name: "X" }], fitOffTasks: [{ id: "k2", name: "Y" }] },
          ],
        },
      ],
    };
    const { summary, areaGroups } = generateTasksForJob(full, rules, { newId: ids() });
    expect(summary.areasFilled).toBe(0);
    expect(summary.areasSkippedNonEmpty).toBe(1);
    expect(areaGroups[0]!.areas[0]!.roughInTasks!.map((t) => t.name)).toEqual(["X"]); // unchanged
  });

  it("does not mutate the input job", () => {
    const input = {
      type: "t_resi",
      areaGroups: [{ id: "g1", name: "L1", areas: [{ id: "a1", name: "Bathroom" }] }],
    };
    const snapshot = JSON.stringify(input);
    generateTasksForJob(input, rules, { newId: ids() });
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("generateTasksForJob — merge mode (explicit confirm path)", () => {
  it("merges generated names into a non-empty list, preserving existing ids by name", () => {
    const rules = [rule({ areaPattern: "bath", roughIn: ["Existing", "New One"] })];
    const j = {
      type: "t_resi",
      areaGroups: [
        { id: "g1", name: "L1", areas: [{ id: "a1", name: "Bathroom", roughInTasks: [{ id: "keep-me", name: "Existing" }] }] },
      ],
    };
    const { areaGroups, summary } = generateTasksForJob(j, rules, { mode: "merge", newId: ids() });
    const tasks = areaGroups[0]!.areas[0]!.roughInTasks!;
    expect(tasks.map((t) => t.name)).toEqual(["Existing", "New One"]);
    expect(tasks.find((t) => t.name === "Existing")!.id).toBe("keep-me"); // id preserved
    expect(summary.roughInAdded).toBe(1);
  });
});

describe("normaliseRules (server validation + id minting)", () => {
  const nano = (p: string) => `${p}fixed`;
  it("mints ids for new rules and trims names", () => {
    const { rules, error } = normaliseRules(
      [{ areaPattern: " bath ", roughIn: ["  Run cable ", ""], fitOff: [] }],
      nano
    );
    expect(error).toBeUndefined();
    expect(rules![0]!.id).toBe("tr_fixed");
    expect(rules![0]!.areaPattern).toBe("bath");
    expect(rules![0]!.roughIn).toEqual(["Run cable"]);
  });
  it("rejects a rule with no tasks", () => {
    const { error } = normaliseRules([{ roughIn: [], fitOff: [] }], nano);
    expect(error).toMatch(/rule 1.*at least one/i);
  });
  it("rejects a non-array", () => {
    expect(normaliseRules("nope", nano).error).toMatch(/must be an array/i);
  });
});

describe("validateRules (advisory UI mirror)", () => {
  it("rejects a rule with no tasks", () => {
    const errs = validateRules([{ roughIn: [], fitOff: [] }]);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toMatch(/at least one/i);
  });
  it("accepts a catch-all rule that seeds tasks", () => {
    expect(validateRules([{ jobType: null, areaPattern: null, roughIn: ["x"], fitOff: [] }])).toEqual([]);
  });
  it("flags an over-long area pattern", () => {
    expect(validateRules([{ areaPattern: "x".repeat(121), roughIn: ["x"], fitOff: [] }])).toHaveLength(1);
  });
});
