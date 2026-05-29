import { describe, expect, it } from "vitest";
import {
  actionLabel,
  groupLabel,
  summariseJobActivity,
  targetGroup,
} from "./format";
import type { AuditLogEntry } from "./types";

function ent(over: Partial<AuditLogEntry>): AuditLogEntry {
  return {
    id: "al_x",
    ts: "2026-05-29T00:00:00.000Z",
    action: "evidence.captured",
    actorId: "u",
    actorName: "Sam",
    actorRole: "tradie",
    jobId: "job-1",
    targetType: "evidence",
    targetId: "ev_x",
    summary: "x",
    metadata: {},
    ...over,
  } as AuditLogEntry;
}

describe("actionLabel", () => {
  it("returns plain-English labels for known verbs", () => {
    expect(actionLabel("evidence.captured")).toBe("Captured evidence");
    expect(actionLabel("snag.created")).toBe("Raised snag");
    expect(actionLabel("observation.converted_to_snag")).toBe("Converted observation to snag");
    expect(actionLabel("itp.signed_off")).toBe("Signed off ITP");
  });
});

describe("targetGroup", () => {
  it("groups itp_template + itp_instance under 'itp'", () => {
    expect(targetGroup("itp_template")).toBe("itp");
    expect(targetGroup("itp_instance")).toBe("itp");
  });
  it("maps the field-to-office records to their own groups", () => {
    expect(targetGroup("evidence")).toBe("evidence");
    expect(targetGroup("snag")).toBe("snag");
    expect(targetGroup("observation")).toBe("observation");
  });
  it("maps employee/invite to 'other' (they have no jobId so never appear in the per-job feed)", () => {
    expect(targetGroup("employee")).toBe("other");
    expect(targetGroup("invite")).toBe("other");
  });
});

describe("summariseJobActivity", () => {
  it("counts by group", () => {
    const s = summariseJobActivity([
      ent({ id: "1", targetType: "evidence" }),
      ent({ id: "2", targetType: "evidence" }),
      ent({ id: "3", targetType: "snag", action: "snag.created" }),
      ent({ id: "4", targetType: "itp_instance", action: "itp.attached" }),
      ent({ id: "5", targetType: "observation", action: "observation.converted_to_snag" }),
    ]);
    expect(s).toEqual({ total: 5, evidence: 2, snag: 1, itp: 1, observation: 1, other: 0 });
  });

  it("handles an empty list", () => {
    expect(summariseJobActivity([])).toEqual({
      total: 0,
      evidence: 0,
      snag: 0,
      itp: 0,
      observation: 0,
      other: 0,
    });
  });
});

describe("groupLabel", () => {
  it("returns human labels", () => {
    expect(groupLabel("evidence")).toBe("Evidence");
    expect(groupLabel("snag")).toBe("Snags");
    expect(groupLabel("itp")).toBe("ITPs");
    expect(groupLabel("observation")).toBe("Observations");
  });
});
