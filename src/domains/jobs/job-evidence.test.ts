import { describe, expect, it } from "vitest";
import { latestJobPhotos, summariseJobEvidence } from "./job-evidence";
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

  it("attributes provenance from the real source stamp (field vs office)", () => {
    const s = summariseJobEvidence(
      [
        ev({ id: "a", source: "phil" }),
        ev({ id: "b", source: "phil" }),
        ev({ id: "c", source: "admin" }),
      ],
      "job-1",
    );
    expect(s.fromField).toBe(2);
    expect(s.fromOffice).toBe(1);
    expect(s.fromField + s.fromOffice).toBe(s.total);
  });

  it("never guesses provenance — reserved/unknown sources count in total only", () => {
    const weird = { ...ev({ id: "c" }), source: "weird" } as unknown as EvidenceItem;
    const s = summariseJobEvidence(
      [ev({ id: "a", source: "phil" }), ev({ id: "b", source: "system" }), weird],
      "job-1",
    );
    expect(s.total).toBe(3);
    expect(s.fromField).toBe(1);
    expect(s.fromOffice).toBe(0);
  });

  it("splits captures by kind (photo vs note)", () => {
    const s = summariseJobEvidence(
      [
        ev({ id: "a", kind: "photo", photoId: "p", photoUrl: "u" }),
        ev({ id: "b", kind: "note", note: "tap done", photoId: null, photoUrl: null }),
        ev({ id: "c", kind: "note", note: "second note", photoId: null, photoUrl: null }),
      ],
      "job-1",
    );
    expect(s.photos).toBe(1);
    expect(s.notes).toBe(2);
    expect(s.photos + s.notes).toBe(s.total);
  });

  it("#233 — counts as-built-flagged captures; absence is not counted (honest zero)", () => {
    const none = summariseJobEvidence([ev({ id: "a" }), ev({ id: "b" })], "job-1");
    expect(none.asBuilt).toBe(0);

    const s = summariseJobEvidence(
      [
        ev({ id: "a", asBuilt: true } as Partial<EvidenceItem>),
        ev({ id: "b", asBuilt: true } as Partial<EvidenceItem>),
        ev({ id: "c" }),
        ev({ id: "d", asBuilt: false } as Partial<EvidenceItem>),
      ],
      "job-1",
    );
    // Only explicit true counts; absent + false do not (never inferred).
    expect(s.asBuilt).toBe(2);
  });
});

describe("latestJobPhotos", () => {
  it("returns newest-first photo thumbs, skipping notes, URL-less rows and other jobs", () => {
    const items = [
      ev({ id: "old", capturedAt: "2026-08-01T09:00:00Z" }),
      ev({ id: "new", capturedAt: "2026-08-08T09:00:00Z", thumbnailUrl: "https://blob/t-new.jpg" } as Partial<EvidenceItem>),
      ev({ id: "note", kind: "note", note: "x", photoId: null, photoUrl: null }),
      ev({ id: "nourl", photoUrl: null } as Partial<EvidenceItem>),
      ev({ id: "otherjob", jobId: "job-2" }),
    ];
    const thumbs = latestJobPhotos(items, "job-1", 6);
    expect(thumbs.map((t) => t.id)).toEqual(["new", "old"]);
    // thumbnailUrl preferred when present, photoUrl otherwise.
    expect(thumbs[0]!.url).toBe("https://blob/t-new.jpg");
    expect(thumbs[1]!.url).toBe("https://blob/p1.jpg");
  });

  it("caps at the limit and returns [] for empty input or limit 0", () => {
    const items = [
      ev({ id: "a", capturedAt: "2026-08-03T09:00:00Z" }),
      ev({ id: "b", capturedAt: "2026-08-02T09:00:00Z" }),
      ev({ id: "c", capturedAt: "2026-08-01T09:00:00Z" }),
    ];
    expect(latestJobPhotos(items, "job-1", 2).map((t) => t.id)).toEqual(["a", "b"]);
    expect(latestJobPhotos([], "job-1", 6)).toEqual([]);
    expect(latestJobPhotos(items, "job-1", 0)).toEqual([]);
  });
});
