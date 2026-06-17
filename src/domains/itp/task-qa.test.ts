import { describe, expect, it } from "vitest";
import {
  buildTaskQaProjection,
  itpAppliesToTask,
  taskQaForCanonicalTask,
} from "./task-qa";
import type { ITPInstance } from "./types";
import { buildCanonicalTaskIndex, type CanonicalTask } from "@/domains/jobs/task-index";
import type { Job } from "@/domains/jobs/types";

/**
 * #505 — task-scoped QA/ITP projection. Proves the HONEST association: a check
 * applies to a task only via job/area scope (level/switchboard never map);
 * archived checks are excluded; the projection is canonical-keyed (no bare-taskId
 * collapse); and the granularity is reported as area-or-job, never per-task.
 */

function itp(over: Partial<ITPInstance> = {}): ITPInstance {
  return {
    id: "itp_1",
    templateId: "tpl_1",
    templateSnapshot: { name: "Final test", points: [] },
    scope: "area",
    scopeId: "east",
    status: "pending",
    results: {},
    createdAt: "2026-06-18T00:00:00.000Z",
    createdBy: "u_admin",
    updatedAt: "2026-06-18T00:00:00.000Z",
    ...over,
  } as unknown as ITPInstance;
}

function job(): Job {
  return {
    id: "j1",
    name: "J1",
    status: "active",
    roughInTasks: [{ id: "t1", name: "Rough-in power" }],
    areaGroups: [
      { id: "g1", name: "G", areas: [{ id: "east", name: "East" }, { id: "west", name: "West" }] },
    ],
  } as unknown as Job;
}

const index = () => buildCanonicalTaskIndex({ job: job() });
const eastTask = (): CanonicalTask => index().find((t) => t.areaId === "east")!;
const westTask = (): CanonicalTask => index().find((t) => t.areaId === "west")!;

describe("itpAppliesToTask — honest scope mapping", () => {
  it("a job-scoped check applies to every task", () => {
    const j = itp({ scope: "job", scopeId: undefined });
    expect(itpAppliesToTask(j, eastTask())).toBe(true);
    expect(itpAppliesToTask(j, westTask())).toBe(true);
  });

  it("an area-scoped check applies only to its area's tasks", () => {
    const a = itp({ scope: "area", scopeId: "east" });
    expect(itpAppliesToTask(a, eastTask())).toBe(true);
    expect(itpAppliesToTask(a, westTask())).toBe(false);
  });

  it("level / switchboard scopes never map to a task", () => {
    expect(itpAppliesToTask(itp({ scope: "level", scopeId: "L1" }), eastTask())).toBe(false);
    expect(itpAppliesToTask(itp({ scope: "switchboard", scopeId: "DB-1" }), eastTask())).toBe(false);
  });

  it("archived checks never apply", () => {
    expect(itpAppliesToTask(itp({ scope: "job", archived: true }), eastTask())).toBe(false);
  });
});

describe("taskQaForCanonicalTask — per-task tally", () => {
  it("aggregates applying checks with signed-off / outstanding counts", () => {
    const instances = [
      itp({ id: "a", scope: "area", scopeId: "east", status: "signed-off", templateSnapshot: { name: "Rough-in QA", points: [] } }),
      itp({ id: "b", scope: "job", status: "pending", templateSnapshot: { name: "Energisation", points: [] } }),
      itp({ id: "c", scope: "area", scopeId: "west", status: "pending" }), // other area — excluded
    ];
    const view = taskQaForCanonicalTask(eastTask(), instances);
    expect(view.total).toBe(2);
    expect(view.signedOff).toBe(1);
    expect(view.outstanding).toBe(1);
    expect(view.granularity).toBe("area-or-job");
    expect(view.checks.map((c) => c.itpId).sort()).toEqual(["a", "b"]);
    expect(view.checks.find((c) => c.itpId === "a")?.scope).toBe("area");
    expect(view.checks.find((c) => c.itpId === "b")?.scope).toBe("job");
    expect(view.checks.find((c) => c.itpId === "a")?.name).toBe("Rough-in QA");
  });

  it("a task with no applying check has an empty view", () => {
    const view = taskQaForCanonicalTask(eastTask(), [itp({ scope: "area", scopeId: "west" })]);
    expect(view.total).toBe(0);
    expect(view.checks).toEqual([]);
  });
});

describe("buildTaskQaProjection — canonical-keyed, honest-empty", () => {
  it("keys by canonical id and omits tasks with no QA", () => {
    const idx = index();
    const instances = [itp({ scope: "area", scopeId: "east", status: "witnessed" })];
    const map = buildTaskQaProjection(idx, instances);
    // only the east task is present; west (no applying check) is absent
    expect(map.has(eastTask().id)).toBe(true);
    expect(map.has(westTask().id)).toBe(false);
    expect(map.get(eastTask().id)?.taskId).toBe(eastTask().id);
    expect(map.get(eastTask().id)?.taskId).toMatch(/^ct_[0-9a-f]{8}$/);
  });

  it("a job-scoped check lands on every task's view (keyed by distinct canonical ids)", () => {
    const idx = index();
    const map = buildTaskQaProjection(idx, [itp({ scope: "job", scopeId: undefined })]);
    expect(map.has(eastTask().id)).toBe(true);
    expect(map.has(westTask().id)).toBe(true);
    expect(eastTask().id).not.toBe(westTask().id); // no bare-taskId collapse
  });

  it("empty when there are no ITP instances", () => {
    expect(buildTaskQaProjection(index(), []).size).toBe(0);
  });
});
