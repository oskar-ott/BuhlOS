import { describe, expect, it } from "vitest";
import { taskBlockersFromObservations } from "./task-blockers";
import type { ObservationItem } from "./types";
import { deriveCanonicalTaskId, buildCanonicalTaskIndex } from "@/domains/jobs/task-index";
import { deriveTaskReadiness } from "@/domains/jobs/task-blockers";
import type { Job } from "@/domains/jobs/types";

/**
 * #504 — observations → canonical task blockers. Proves: only open, task-scoped,
 * blocking-type observations become blockers; identity is canonical (no
 * bare-taskId collapse); types map correctly; and a derived blocker actually
 * flips its task to `blocked` through the #482 readiness engine.
 */

const JOB = "j1";

function obs(over: Partial<ObservationItem> = {}): ObservationItem {
  return {
    id: "ob_1",
    jobId: JOB,
    type: "rfi",
    title: "Awaiting RFI answer",
    status: "new",
    stage: "roughIn",
    areaId: "east",
    taskId: "t1",
    ...over,
  } as unknown as ObservationItem;
}

describe("taskBlockersFromObservations — qualifying filter", () => {
  it("an open, task-scoped, blocking-type observation becomes one canonical blocker", () => {
    const blockers = taskBlockersFromObservations({ observations: [obs()], jobId: JOB });
    expect(blockers).toHaveLength(1);
    const b = blockers[0]!;
    expect(b.id).toBe("ob_1");
    expect(b.type).toBe("rfi");
    expect(b.title).toBe("Awaiting RFI answer");
    expect(b.status).toBe("open");
    expect(b.areaRefs).toEqual(["east"]);
    expect(b.taskId).toBe(
      deriveCanonicalTaskId({ jobId: JOB, areaId: "east", stage: "roughIn", taskId: "t1" }),
    );
  });

  it("skips observations that are not task-scoped (missing area/stage/task)", () => {
    const cases = [
      obs({ id: "a", areaId: null }),
      obs({ id: "b", stage: null }),
      obs({ id: "c", taskId: null }),
    ];
    expect(taskBlockersFromObservations({ observations: cases, jobId: JOB })).toHaveLength(0);
  });

  it("skips closed observations (converted / resolved / record_only)", () => {
    for (const status of ["converted", "resolved", "record_only"] as const) {
      expect(taskBlockersFromObservations({ observations: [obs({ status })], jobId: JOB })).toHaveLength(0);
    }
  });

  it("keeps the other open statuses (new / needs_action / in_review)", () => {
    for (const status of ["new", "needs_action", "in_review"] as const) {
      expect(taskBlockersFromObservations({ observations: [obs({ status })], jobId: JOB })).toHaveLength(1);
    }
  });

  it("skips non-blocking types (note / defect / safety / evidence)", () => {
    for (const type of ["note", "defect", "safety", "evidence"] as const) {
      expect(taskBlockersFromObservations({ observations: [obs({ type })], jobId: JOB })).toHaveLength(0);
    }
  });
});

describe("taskBlockersFromObservations — type mapping", () => {
  it("maps each blocking type to the #482 TaskBlockerType", () => {
    const map: Record<string, string> = {
      blocker: "other",
      rfi: "rfi",
      variation: "approval",
      material_request: "material",
      plan_mismatch: "drawing",
      client_instruction: "client",
    };
    for (const [obsType, blockerType] of Object.entries(map)) {
      const [b] = taskBlockersFromObservations({
        observations: [obs({ type: obsType as ObservationItem["type"] })],
        jobId: JOB,
      });
      expect(b?.type).toBe(blockerType);
    }
  });
});

describe("taskBlockersFromObservations — canonical identity", () => {
  it("the same taskId in different areas yields distinct canonical blockers", () => {
    const east = obs({ id: "e", areaId: "east", taskId: "t_shared" });
    const west = obs({ id: "w", areaId: "west", taskId: "t_shared" });
    const blockers = taskBlockersFromObservations({ observations: [east, west], jobId: JOB });
    expect(blockers).toHaveLength(2);
    expect(blockers[0]!.taskId).not.toBe(blockers[1]!.taskId);
  });

  it("multiple qualifying observations on one task yield multiple blockers", () => {
    const a = obs({ id: "a", type: "rfi" });
    const b = obs({ id: "b", type: "variation" });
    const blockers = taskBlockersFromObservations({ observations: [a, b], jobId: JOB });
    expect(blockers).toHaveLength(2);
    expect(new Set(blockers.map((x) => x.taskId)).size).toBe(1); // same task
  });
});

describe("taskBlockersFromObservations — end-to-end with #482 readiness", () => {
  function job(): Job {
    return {
      id: JOB,
      name: "J1",
      status: "active",
      roughInTasks: [{ id: "t1", name: "Rough-in power" }],
      areaGroups: [{ id: "g1", name: "G", areas: [{ id: "east", name: "East" }, { id: "west", name: "West" }] }],
    } as unknown as Job;
  }

  it("a derived blocker flips its task to blocked; the same template in another area stays ready", () => {
    const index = buildCanonicalTaskIndex({ job: job() });
    const blockers = taskBlockersFromObservations({
      observations: [obs({ areaId: "east", taskId: "t1" })],
      jobId: JOB,
    });
    const eastTask = index.find((t) => t.source.areaId === "east")!;
    const westTask = index.find((t) => t.source.areaId === "west")!;
    expect(deriveTaskReadiness({ task: eastTask, blockers })).toBe("blocked");
    expect(deriveTaskReadiness({ task: westTask, blockers })).toBe("ready"); // canonical isolation
  });
});
