import { describe, expect, it } from "vitest";
import {
  meetsLevel,
  workerSkillLevel,
  workersWithSkill,
  skillCoverage,
  buildSkillsMatrix,
  findDuplicateSkillLabel,
  type Skill,
  type WorkerSkill,
} from "./skills";

const SKILLS: Skill[] = [
  { id: "test-tag", label: "Test & Tag" },
  { id: "switchboard", label: "Switchboard build" },
  { id: "old", label: "Old skill", archived: true },
];
const WORKERS = [
  { id: "u1", name: "Sam" },
  { id: "u2", name: "Jo" },
];
const ENTRIES: WorkerSkill[] = [
  { workerId: "u1", skillId: "test-tag", level: "can-do" },
  { workerId: "u1", skillId: "test-tag", level: "can-supervise" }, // strongest wins
  { workerId: "u1", skillId: "switchboard", level: "experienced" },
  { workerId: "u2", skillId: "test-tag", level: "experienced" },
];

describe("level ordering", () => {
  it("meetsLevel respects can-do < experienced < can-supervise", () => {
    expect(meetsLevel("can-supervise", "experienced")).toBe(true);
    expect(meetsLevel("experienced", "experienced")).toBe(true);
    expect(meetsLevel("can-do", "experienced")).toBe(false);
  });
  it("workerSkillLevel returns the strongest entry (null when none)", () => {
    expect(workerSkillLevel(ENTRIES, "u1", "test-tag")).toBe("can-supervise");
    expect(workerSkillLevel(ENTRIES, "u2", "switchboard")).toBeNull();
  });
});

describe("workersWithSkill", () => {
  it("returns everyone with the skill (default any level), strongest first", () => {
    expect(workersWithSkill(ENTRIES, "test-tag")).toEqual(["u1", "u2"]); // u1 can-supervise, u2 experienced
  });
  it("filters by a minimum level", () => {
    expect(workersWithSkill(ENTRIES, "test-tag", "can-supervise")).toEqual(["u1"]);
    expect(workersWithSkill(ENTRIES, "switchboard", "can-supervise")).toEqual([]);
  });
});

describe("skillCoverage", () => {
  it("counts holders by their highest level (each worker once)", () => {
    expect(skillCoverage(ENTRIES, "test-tag")).toEqual({
      skillId: "test-tag",
      total: 2,
      byLevel: { "can-do": 0, experienced: 1, "can-supervise": 1 },
    });
  });
});

describe("buildSkillsMatrix", () => {
  it("rows × non-archived skills with highest level per cell + skillCount", () => {
    const m = buildSkillsMatrix({ skills: SKILLS, workers: WORKERS, entries: ENTRIES });
    expect(m.skills.map((s) => s.id)).toEqual(["test-tag", "switchboard"]); // archived dropped
    const u1 = m.rows.find((r) => r.worker.id === "u1")!;
    expect(u1.cells).toEqual({ "test-tag": "can-supervise", switchboard: "experienced" });
    expect(u1.skillCount).toBe(2);
    const u2 = m.rows.find((r) => r.worker.id === "u2")!;
    expect(u2.cells).toEqual({ "test-tag": "experienced", switchboard: null });
    expect(u2.skillCount).toBe(1);
  });
});

describe("findDuplicateSkillLabel", () => {
  it("flags a case-insensitive duplicate label (archived ignored)", () => {
    expect(findDuplicateSkillLabel(SKILLS)).toBeNull();
    expect(
      findDuplicateSkillLabel([{ id: "a", label: "Test & Tag" }, { id: "b", label: "test & tag" }]),
    ).toBe("test & tag");
  });
});
