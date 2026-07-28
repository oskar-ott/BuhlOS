import { describe, expect, it } from "vitest";

import {
  isPhilJobRoom,
  jobWorkCounts,
  roomForAttentionAnchor,
} from "./philJobRooms";
import type { CanonicalTask } from "@/domains/jobs/task-index";

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

describe("jobWorkCounts", () => {
  it("partitions done / going / todo from real states", () => {
    const tasks = [
      task("d1", "a1", "complete"),
      task("g1", "a1", "in_progress"),
      task("b1", "a2", "not_started"),
      task("t1", "a2", "not_started"),
    ];
    expect(jobWorkCounts(tasks)).toEqual({ total: 4, done: 1, going: 1, todo: 2 });
  });

  it("an empty job derives all zeros", () => {
    expect(jobWorkCounts([])).toEqual({ total: 0, done: 0, going: 0, todo: 0 });
  });
});

describe("roomForAttentionAnchor", () => {
  it("maps each flag-off section anchor to the room that now owns it", () => {
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
