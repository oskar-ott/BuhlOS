import { describe, expect, it } from "vitest";
import {
  CreateObservationPayloadSchema,
  ObservationItemSchema,
  OBSERVATION_TYPES,
  UpdateObservationPayloadSchema,
} from "./schema";
import {
  WORKER_CAPTURE_OPTIONS,
  compareForInbox,
  isOpenObservation,
  requiresActionForOption,
  requiresActionForType,
  summariseInbox,
  workerOptionByKey,
} from "./service";
import type { ObservationItem } from "./types";

function item(over: Partial<ObservationItem> & { id: string }): ObservationItem {
  return {
    jobId: "job-1",
    type: "note",
    title: "x",
    status: "new",
    priority: "normal",
    source: "phil",
    requiresAction: false,
    photoUrls: [],
    createdById: "u1",
    createdByName: "Worker",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...over,
  } as ObservationItem;
}

describe("requiresActionForType", () => {
  it("note + evidence are record-only; everything else needs action", () => {
    expect(requiresActionForType("note")).toBe(false);
    expect(requiresActionForType("evidence")).toBe(false);
    for (const t of OBSERVATION_TYPES) {
      if (t === "note" || t === "evidence") continue;
      expect(requiresActionForType(t)).toBe(true);
    }
  });
});

describe("WORKER_CAPTURE_OPTIONS", () => {
  it("every option maps to a valid observation type", () => {
    for (const o of WORKER_CAPTURE_OPTIONS) {
      expect(OBSERVATION_TYPES).toContain(o.type);
    }
  });

  it("does not expose the evidence type (photos stay the CaptureSheet flow)", () => {
    expect(WORKER_CAPTURE_OPTIONS.some((o) => o.type === "evidence")).toBe(false);
  });

  it("the 'Not sure — office review' option forces requiresAction on a note", () => {
    const unsure = workerOptionByKey("unsure");
    expect(unsure?.type).toBe("note");
    expect(requiresActionForType("note")).toBe(false);
    expect(requiresActionForOption(unsure!)).toBe(true);
  });

  it("a plain note option inherits the type default (false)", () => {
    const note = workerOptionByKey("note");
    expect(requiresActionForOption(note!)).toBe(false);
  });
});

describe("isOpenObservation", () => {
  it("resolved/converted/record_only are closed; the rest are open", () => {
    expect(isOpenObservation("new")).toBe(true);
    expect(isOpenObservation("needs_action")).toBe(true);
    expect(isOpenObservation("in_review")).toBe(true);
    expect(isOpenObservation("resolved")).toBe(false);
    expect(isOpenObservation("converted")).toBe(false);
    expect(isOpenObservation("record_only")).toBe(false);
  });
});

describe("compareForInbox (exception-first)", () => {
  it("puts needs_action before new before resolved", () => {
    const list = [
      item({ id: "resolved", status: "resolved" }),
      item({ id: "new", status: "new" }),
      item({ id: "needs", status: "needs_action" }),
    ];
    const ordered = list.slice().sort(compareForInbox).map((o) => o.id);
    expect(ordered).toEqual(["needs", "new", "resolved"]);
  });

  it("within a status, urgent beats normal beats low", () => {
    const list = [
      item({ id: "low", status: "new", priority: "low" }),
      item({ id: "urgent", status: "new", priority: "urgent" }),
      item({ id: "normal", status: "new", priority: "normal" }),
    ];
    const ordered = list.slice().sort(compareForInbox).map((o) => o.id);
    expect(ordered).toEqual(["urgent", "normal", "low"]);
  });
});

describe("summariseInbox", () => {
  it("counts open needs-action, high/urgent, blockers and closed correctly", () => {
    const s = summariseInbox([
      item({ id: "1", status: "needs_action", requiresAction: true, type: "blocker", priority: "high" }),
      item({ id: "2", status: "new", requiresAction: true, type: "rfi", priority: "urgent" }),
      item({ id: "3", status: "new", requiresAction: false, type: "note", priority: "low" }),
      item({ id: "4", status: "resolved", requiresAction: false, type: "note", priority: "normal" }),
      item({ id: "5", status: "converted", requiresAction: true, type: "variation", priority: "high" }),
    ]);
    expect(s.total).toBe(5);
    expect(s.open).toBe(3); // 1,2,3
    expect(s.newOrNeedsAction).toBe(3); // 1,2,3
    expect(s.needsAction).toBe(2); // 1,2 (open + requiresAction)
    expect(s.highUrgent).toBe(2); // 1 (high) + 2 (urgent); 5 is converted (closed)
    expect(s.blockers).toBe(1); // 1
    expect(s.resolvedOrRecord).toBe(2); // 4,5
  });
});

describe("CreateObservationPayloadSchema", () => {
  it("accepts a minimal valid payload", () => {
    const r = CreateObservationPayloadSchema.safeParse({ type: "blocker", title: "Cable path blocked" });
    expect(r.success).toBe(true);
  });

  it("rejects an invalid type", () => {
    const r = CreateObservationPayloadSchema.safeParse({ type: "nonsense", title: "x" });
    expect(r.success).toBe(false);
  });

  it("rejects an empty title", () => {
    const r = CreateObservationPayloadSchema.safeParse({ type: "note", title: "   " });
    expect(r.success).toBe(false);
  });

  it("requires stage when taskId is provided", () => {
    const r = CreateObservationPayloadSchema.safeParse({
      type: "defect",
      title: "x",
      taskId: "t1",
    });
    expect(r.success).toBe(false);
  });

  it("preserves optional area/stage/task and link context", () => {
    const r = CreateObservationPayloadSchema.safeParse({
      type: "defect",
      title: "Light fitting damaged",
      stage: "fitOff",
      areaId: "a1",
      taskId: "t1",
      linkedEvidenceId: "ev_1",
      photoUrls: ["https://x/1.jpg"],
      priority: "high",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.areaId).toBe("a1");
      expect(r.data.stage).toBe("fitOff");
      expect(r.data.linkedEvidenceId).toBe("ev_1");
    }
  });

  it("does not accept a client-set status (status is server-owned)", () => {
    const r = CreateObservationPayloadSchema.safeParse({ type: "note", title: "x", status: "resolved" });
    // status is stripped (not in the create schema) — parse still succeeds,
    // but the field never reaches the server payload.
    expect(r.success).toBe(true);
    if (r.success) expect("status" in r.data).toBe(false);
  });
});

describe("UpdateObservationPayloadSchema", () => {
  it("requires an id and at least one changed field", () => {
    expect(UpdateObservationPayloadSchema.safeParse({ id: "o1" }).success).toBe(false);
    expect(UpdateObservationPayloadSchema.safeParse({ status: "resolved" }).success).toBe(false);
    expect(
      UpdateObservationPayloadSchema.safeParse({ id: "o1", status: "resolved" }).success
    ).toBe(true);
  });

  it("rejects an invalid status", () => {
    expect(
      UpdateObservationPayloadSchema.safeParse({ id: "o1", status: "nope" }).success
    ).toBe(false);
  });
});

describe("ObservationItemSchema", () => {
  it("parses a full persisted item and passes through unknown fields", () => {
    const r = ObservationItemSchema.safeParse({
      ...item({ id: "o1" }),
      futureField: "ok",
    });
    expect(r.success).toBe(true);
  });
});
