import { describe, expect, it } from "vitest";

import {
  blockedCountByArea,
  blockedTasks,
  isPhilJobRoom,
  jobWorkCounts,
  owedProofCountByArea,
  owedProofItems,
  roomForAttentionAnchor,
} from "./philJobRooms";
import type { CanonicalTask } from "@/domains/jobs/task-index";
import type { TaskBlocker } from "@/domains/jobs/task-blockers";
import type { EvidenceLink, WorkPackage } from "@/domains/job-control/types";

/**
 * The four-rooms derivations (phil_job_rooms — #133). These are the room-tab
 * BADGES ("critical state never hidden behind navigation"), so the honesty
 * rules are load-bearing: every count derives from real inputs, a job with
 * nothing qualifying derives zero, and nothing is ever invented.
 */

const task = (
  id: string,
  areaId: string,
  state: CanonicalTask["state"],
): CanonicalTask =>
  ({
    id,
    jobId: "j1",
    templateId: id,
    title: id,
    areaId,
    areaRefs: [areaId],
    stage: "roughIn",
    state,
    system: "general",
    source: { areaId, stage: "roughIn", taskId: id },
  }) as CanonicalTask;

const blocker = (taskId: string, over: Partial<TaskBlocker> = {}): TaskBlocker =>
  ({
    id: `b-${taskId}`,
    taskId,
    type: "rfi",
    title: "Waiting on the office",
    status: "open",
    ...over,
  }) as TaskBlocker;

const wp = (id: string, over: Partial<WorkPackage> = {}): WorkPackage =>
  ({
    id,
    jobId: "j1",
    title: `Package ${id}`,
    scopeClauseIds: [],
    boqLineRefs: [],
    taskRefs: [{ areaId: "a1", stage: "roughIn", taskId: "t1" }],
    order: 0,
    ...over,
  }) as unknown as WorkPackage;

const metLink = (workPackageId: string, requiredEvidenceId: string): EvidenceLink =>
  ({
    id: `el-${requiredEvidenceId}`,
    jobId: "j1",
    workPackageId,
    requiredEvidenceId,
    evidenceId: "ev1",
  }) as unknown as EvidenceLink;

describe("blockedTasks", () => {
  it("returns [] when there are no blockers (nothing invented)", () => {
    expect(blockedTasks([task("ct1", "a1", "not_started")], [])).toEqual([]);
  });

  it("marks a not-complete task with an open blocker, carrying the reason", () => {
    const t = task("ct1", "a1", "not_started");
    const result = blockedTasks([t], [blocker("ct1")]);
    expect(result).toHaveLength(1);
    expect(result[0]!.task.id).toBe("ct1");
    expect(result[0]!.reasons).toEqual(["Waiting on the office"]);
  });

  it("never marks a COMPLETE task blocked, and ignores non-open blockers", () => {
    const done = task("ct1", "a1", "complete");
    const todo = task("ct2", "a1", "not_started");
    const result = blockedTasks(
      [done, todo],
      [blocker("ct1"), blocker("ct2", { status: "cleared" as TaskBlocker["status"] })],
    );
    expect(result).toEqual([]);
  });

  it("counts a multi-blocker task once, with every reason", () => {
    const t = task("ct1", "a1", "in_progress");
    const result = blockedTasks(
      [t],
      [blocker("ct1"), blocker("ct1", { id: "b2", title: "No materials" })],
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.reasons).toEqual(["Waiting on the office", "No materials"]);
  });
});

describe("jobWorkCounts", () => {
  it("partitions done / going / blocked / todo from real states + blockers", () => {
    const tasks = [
      task("d1", "a1", "complete"),
      task("g1", "a1", "in_progress"),
      task("b1", "a2", "not_started"),
      task("t1", "a2", "not_started"),
    ];
    const blocked = blockedTasks(tasks, [blocker("b1")]);
    expect(jobWorkCounts(tasks, blocked)).toEqual({
      total: 4,
      done: 1,
      going: 1,
      blocked: 1,
      todo: 1,
    });
  });

  it("a blocked in-progress task counts as blocked, not going", () => {
    const tasks = [task("x", "a1", "in_progress")];
    const blocked = blockedTasks(tasks, [blocker("x")]);
    const counts = jobWorkCounts(tasks, blocked);
    expect(counts.blocked).toBe(1);
    expect(counts.going).toBe(0);
  });

  it("an empty job derives all zeros", () => {
    expect(jobWorkCounts([], [])).toEqual({
      total: 0,
      done: 0,
      going: 0,
      blocked: 0,
      todo: 0,
    });
  });
});

describe("blockedCountByArea", () => {
  it("groups distinct blocked tasks by their area", () => {
    const tasks = [
      task("x", "a1", "not_started"),
      task("y", "a1", "not_started"),
      task("z", "a2", "not_started"),
    ];
    const blocked = blockedTasks(tasks, [blocker("x"), blocker("y"), blocker("z")]);
    const byArea = blockedCountByArea(blocked);
    expect(byArea.get("a1")).toBe(2);
    expect(byArea.get("a2")).toBe(1);
  });
});

describe("owedProofItems", () => {
  it("returns [] when no package carries required evidence (honest absence)", () => {
    expect(owedProofItems([wp("wp1")], [])).toEqual([]);
  });

  it("lists an unmet requirement at package granularity with the package's areas", () => {
    const pkg = wp("wp1", {
      taskRefs: [
        { areaId: "a1", stage: "roughIn", taskId: "t1" },
        { areaId: "a2", stage: "roughIn", taskId: "t2" },
      ],
      requiredEvidence: [{ id: "re1", label: "Covered-work photo", kind: "photo" }],
    } as Partial<WorkPackage>);
    const items = owedProofItems([pkg], []);
    expect(items).toHaveLength(1);
    expect(items[0]!.requirement.label).toBe("Covered-work photo");
    expect(items[0]!.areaIds).toEqual(["a1", "a2"]);
  });

  it("drops a requirement once a REAL link names it (never a photo count)", () => {
    const pkg = wp("wp1", {
      requiredEvidence: [
        { id: "re1", label: "Photo A", kind: "photo" },
        { id: "re2", label: "Photo B", kind: "photo" },
      ],
    } as Partial<WorkPackage>);
    const items = owedProofItems([pkg], [metLink("wp1", "re1")]);
    expect(items).toHaveLength(1);
    expect(items[0]!.requirement.id).toBe("re2");
  });

  it("keeps a per-task-authored requirement scoped to its own task's area", () => {
    const pkg = wp("wp1", {
      taskRefs: [
        { areaId: "a1", stage: "roughIn", taskId: "t1" },
        { areaId: "a2", stage: "roughIn", taskId: "t2" },
      ],
      requiredEvidence: [
        {
          id: "re1",
          label: "This task only",
          kind: "photo",
          taskRef: { areaId: "a2", stage: "roughIn", taskId: "t2" },
        },
      ],
    } as Partial<WorkPackage>);
    const items = owedProofItems([pkg], []);
    expect(items).toHaveLength(1);
    expect(items[0]!.areaIds).toEqual(["a2"]);
  });
});

describe("owedProofCountByArea", () => {
  it("counts an owed item in every area its package delivers into", () => {
    const pkg = wp("wp1", {
      taskRefs: [
        { areaId: "a1", stage: "roughIn", taskId: "t1" },
        { areaId: "a2", stage: "roughIn", taskId: "t2" },
      ],
      requiredEvidence: [{ id: "re1", label: "Photo", kind: "photo" }],
    } as Partial<WorkPackage>);
    const byArea = owedProofCountByArea(owedProofItems([pkg], []));
    expect(byArea.get("a1")).toBe(1);
    expect(byArea.get("a2")).toBe(1);
  });
});

describe("roomForAttentionAnchor", () => {
  it("maps each flag-off section anchor to the room that now owns it", () => {
    expect(roomForAttentionAnchor("#phil-job-snags")).toBe("work");
    expect(roomForAttentionAnchor("#phil-job-itps")).toBe("proof");
    expect(roomForAttentionAnchor("#phil-job-site")).toBe("site");
    // Unknown anchors stay put rather than jumping somewhere wrong.
    expect(roomForAttentionAnchor("#phil-job-unknown")).toBe("now");
  });
});

describe("isPhilJobRoom", () => {
  it("accepts only the four rooms", () => {
    expect(isPhilJobRoom("now")).toBe(true);
    expect(isPhilJobRoom("site")).toBe(true);
    expect(isPhilJobRoom("hours")).toBe(false);
    expect(isPhilJobRoom(undefined)).toBe(false);
  });
});
