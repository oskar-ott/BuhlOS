import { describe, expect, it } from "vitest";
import {
  deriveEvidenceAttention,
  groupEvidenceByStage,
  summariseJobEvidence,
} from "./job-evidence";
import type { EvidenceItem } from "@/domains/evidence/types";

function ev(over: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: "ev-1",
    jobId: "job-1",
    kind: "photo",
    photoId: "p1",
    photoUrl: "https://blob/p1.jpg",
    status: "submitted",
    source: "phil",
    capturedById: "u1",
    capturedByName: "Jack",
    capturedAt: "2026-06-01T09:00:00Z",
    taskId: "t1",
    stage: "roughIn",
    auditLogIds: [],
    createdAt: "2026-06-01T09:00:00Z",
    updatedAt: "2026-06-01T09:00:00Z",
    ...over,
  } as unknown as EvidenceItem;
}

describe("summariseJobEvidence", () => {
  it("returns an honest empty summary for no evidence", () => {
    const s = summariseJobEvidence([], "job-1");
    expect(s.hasAny).toBe(false);
    expect(s.total).toBe(0);
    expect(s.latest).toBeNull();
    expect(s.workerCount).toBe(0);
  });

  it("counts statuses, distinct workers, and newest capture", () => {
    const s = summariseJobEvidence(
      [
        ev({ id: "a", status: "submitted", capturedById: "u1", capturedByName: "Jack", capturedAt: "2026-06-01T09:00:00Z" }),
        ev({ id: "b", status: "reviewed", capturedById: "u2", capturedByName: "Sam", capturedAt: "2026-06-03T11:30:00Z" }),
        ev({ id: "c", status: "rejected", rejectionReason: "blurry", capturedById: "u1", capturedByName: "Jack", capturedAt: "2026-06-02T08:00:00Z" }),
        ev({ id: "d", status: "submitted", capturedById: "u1", capturedByName: "Jack", capturedAt: "2026-05-30T07:00:00Z" }),
      ],
      "job-1",
    );
    expect(s.total).toBe(4);
    expect(s.pendingReview).toBe(2);
    expect(s.reviewed).toBe(1);
    expect(s.rejected).toBe(1);
    expect(s.workerCount).toBe(2);
    expect(s.latest).toEqual({ capturedByName: "Sam", capturedAt: "2026-06-03T11:30:00Z" });
  });

  it("ignores evidence belonging to other jobs (defensive job filter)", () => {
    const s = summariseJobEvidence(
      [ev({ id: "a", jobId: "job-1" }), ev({ id: "b", jobId: "job-2" })],
      "job-1",
    );
    expect(s.total).toBe(1);
  });

  it("counts captures missing context (no task, area, or stage)", () => {
    const s = summariseJobEvidence(
      [
        ev({ id: "a", taskId: "t1", stage: "roughIn", areaId: null }),
        ev({ id: "b", taskId: null, areaId: null, stage: null }),
        ev({ id: "c", taskId: null, areaId: "area-9", stage: null }),
      ],
      "job-1",
    );
    expect(s.missingContext).toBe(1); // only "b" is fully unattached
  });

  it("does not invent rows — only real items count", () => {
    const s = summariseJobEvidence([ev({ id: "a" })], "job-1");
    expect(s.total).toBe(1);
    expect(s.pendingReview + s.reviewed + s.rejected).toBe(1);
  });
});

describe("groupEvidenceByStage", () => {
  it("counts by stage and omits empty stages", () => {
    const groups = groupEvidenceByStage(
      [
        ev({ id: "a", stage: "roughIn" }),
        ev({ id: "b", stage: "roughIn" }),
        ev({ id: "c", stage: "fitOff" }),
        ev({ id: "d", stage: null, taskId: null }),
      ],
      "job-1",
    );
    expect(groups).toEqual([
      { stage: "roughIn", count: 2 },
      { stage: "fitOff", count: 1 },
      { stage: "none", count: 1 },
    ]);
  });

  it("is empty for no evidence", () => {
    expect(groupEvidenceByStage([], "job-1")).toEqual([]);
  });
});

describe("deriveEvidenceAttention", () => {
  it("flags review needed when captures are pending", () => {
    const s = summariseJobEvidence([ev({ status: "submitted" })], "job-1");
    expect(deriveEvidenceAttention(s)).toEqual({ needsReview: true, count: 1 });
  });

  it("is calm when everything is reviewed", () => {
    const s = summariseJobEvidence([ev({ status: "reviewed" })], "job-1");
    expect(deriveEvidenceAttention(s).needsReview).toBe(false);
  });
});
