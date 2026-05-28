import { describe, expect, it } from "vitest";
import {
  AppendAuditLogPayloadSchema,
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  AuditActionSchema,
  AuditLogEntrySchema,
  AuditLogFileSchema,
  AuditTargetTypeSchema,
} from "./schema";
import { entriesForTarget, monthBucket, sortNewestFirst } from "./client";
import type { AuditLogEntry } from "./types";

/* ----------------------------------------------------------------------
 * Schema
 * -------------------------------------------------------------------- */

const validEntry: AuditLogEntry = {
  id: "al_abc12345",
  ts: "2026-05-25T14:30:00.000Z",
  action: "evidence.captured",
  actorId: "user-tradie-1",
  actorName: "Sam",
  actorRole: "tradie",
  jobId: "birdwood-iv3232",
  targetType: "evidence",
  targetId: "ev_xyz12345",
  summary: "photo evidence captured — \"Cabling looks good\"",
  metadata: {
    kind: "photo",
    areaId: "ar_abc",
    stage: "roughIn",
  },
};

describe("AuditLogEntrySchema", () => {
  it("accepts a fully populated entry", () => {
    expect(AuditLogEntrySchema.safeParse(validEntry).success).toBe(true);
  });

  it("accepts an entry with nullable jobId / actorRole", () => {
    const r = AuditLogEntrySchema.safeParse({
      ...validEntry,
      jobId: null,
      actorRole: null,
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown action values", () => {
    expect(
      AuditLogEntrySchema.safeParse({ ...validEntry, action: "evidence.deleted" }).success
    ).toBe(false);
  });

  it("rejects unknown targetType values", () => {
    expect(
      AuditLogEntrySchema.safeParse({ ...validEntry, targetType: "rfi" }).success
    ).toBe(false);
  });

  it("accepts the D.5 snag targetType + verbs", () => {
    const snagCreate = {
      ...validEntry,
      action: "snag.created" as const,
      targetType: "snag" as const,
      targetId: "sn_abc12345",
      summary: 'snag created — "Plug missing earth"',
      metadata: { priority: "high", status: "open" },
    };
    expect(AuditLogEntrySchema.safeParse(snagCreate).success).toBe(true);

    const snagTransition = {
      ...snagCreate,
      action: "snag.transitioned" as const,
      summary: "snag in_progress → resolved",
      metadata: { from: "in_progress", to: "resolved" },
    };
    expect(AuditLogEntrySchema.safeParse(snagTransition).success).toBe(true);
  });

  it("rejects when required fields are missing", () => {
    const cases = [
      "id",
      "ts",
      "action",
      "actorId",
      "actorName",
      "targetType",
      "targetId",
      "summary",
    ];
    for (const f of cases) {
      const broken = { ...validEntry } as Record<string, unknown>;
      delete broken[f];
      expect(AuditLogEntrySchema.safeParse(broken).success).toBe(false);
    }
  });

  it("passes through unknown forward-compat fields (.passthrough)", () => {
    const future = { ...validEntry, requestId: "req_abc" };
    const parsed = AuditLogEntrySchema.safeParse(future);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as { requestId?: string }).requestId).toBe("req_abc");
    }
  });

  it("enum exports stay in sync", () => {
    // D5 added evidence.unreviewed for the reviewed → submitted
    // transition so the History panel can distinguish it from the
    // original review. D.5 added snag.created + snag.transitioned and
    // the 'snag' targetType. E1a adds the five itp.* verbs covering
    // the legacy api/job-itps.js mutating actions + the itp_template
    // / itp_instance target types.
    expect([...AUDIT_ACTIONS].sort()).toEqual([
      "employee.created",
      "employee.disabled",
      "employee.role_changed",
      "employee.updated",
      "evidence.captured",
      "evidence.rejected",
      "evidence.reviewed",
      "evidence.unreviewed",
      "invite.issued",
      "invite.revoked",
      "itp.archived",
      "itp.attached",
      "itp.point.recorded",
      "itp.reopened",
      "itp.signed_off",
      "snag.created",
      "snag.transitioned",
    ]);
    expect([...AUDIT_TARGET_TYPES].sort()).toEqual([
      "employee",
      "evidence",
      "invite",
      "itp_instance",
      "itp_template",
      "snag",
    ]);
  });

  it("AuditActionSchema and AuditTargetTypeSchema enforce the same set", () => {
    expect(AuditActionSchema.safeParse("evidence.captured").success).toBe(true);
    expect(AuditActionSchema.safeParse("evidence.deleted").success).toBe(false);
    expect(AuditTargetTypeSchema.safeParse("evidence").success).toBe(true);
    expect(AuditTargetTypeSchema.safeParse("snag").success).toBe(true);
    expect(AuditActionSchema.safeParse("snag.created").success).toBe(true);
    expect(AuditActionSchema.safeParse("snag.transitioned").success).toBe(true);
    expect(AuditActionSchema.safeParse("snag.deleted").success).toBe(false);
    expect(AuditTargetTypeSchema.safeParse("rfi").success).toBe(false);
    // ITP verbs + target types accepted; nonsense rejected.
    expect(AuditActionSchema.safeParse("itp.attached").success).toBe(true);
    expect(AuditActionSchema.safeParse("itp.point.recorded").success).toBe(true);
    expect(AuditActionSchema.safeParse("itp.signed_off").success).toBe(true);
    expect(AuditActionSchema.safeParse("itp.reopened").success).toBe(true);
    expect(AuditActionSchema.safeParse("itp.archived").success).toBe(true);
    expect(AuditActionSchema.safeParse("itp.deleted").success).toBe(false);
    expect(AuditTargetTypeSchema.safeParse("itp_instance").success).toBe(true);
    expect(AuditTargetTypeSchema.safeParse("itp_template").success).toBe(true);
    expect(AuditTargetTypeSchema.safeParse("itp").success).toBe(false);
  });
});

describe("AuditLogFileSchema", () => {
  it("parses an empty monthly blob", () => {
    expect(AuditLogFileSchema.safeParse({ entries: [] }).success).toBe(true);
  });

  it("parses a monthly blob with multiple entries", () => {
    const r = AuditLogFileSchema.safeParse({
      entries: [
        validEntry,
        {
          ...validEntry,
          id: "al_2",
          action: "evidence.reviewed",
          ts: "2026-05-26T09:00:00.000Z",
        },
      ],
    });
    expect(r.success).toBe(true);
  });
});

describe("AppendAuditLogPayloadSchema", () => {
  it("accepts a minimal evidence.captured payload", () => {
    const r = AppendAuditLogPayloadSchema.safeParse({
      action: "evidence.captured",
      actorId: "user-1",
      actorName: "Sam",
      targetType: "evidence",
      targetId: "ev_1",
      summary: "captured",
    });
    expect(r.success).toBe(true);
  });

  it("rejects when actorName is missing", () => {
    const r = AppendAuditLogPayloadSchema.safeParse({
      action: "evidence.captured",
      actorId: "user-1",
      targetType: "evidence",
      targetId: "ev_1",
      summary: "captured",
    });
    expect(r.success).toBe(false);
  });
});

/* ----------------------------------------------------------------------
 * Client helpers
 * -------------------------------------------------------------------- */

describe("sortNewestFirst", () => {
  it("sorts by ts descending", () => {
    const a: AuditLogEntry = { ...validEntry, id: "a", ts: "2026-05-25T10:00:00Z" };
    const b: AuditLogEntry = { ...validEntry, id: "b", ts: "2026-05-25T11:00:00Z" };
    const c: AuditLogEntry = { ...validEntry, id: "c", ts: "2026-05-25T09:00:00Z" };
    expect(sortNewestFirst([a, b, c]).map((e) => e.id)).toEqual(["b", "a", "c"]);
  });

  it("returns a new array (does not mutate input)", () => {
    const input: AuditLogEntry[] = [
      { ...validEntry, id: "a", ts: "2026-05-25T10:00:00Z" },
      { ...validEntry, id: "b", ts: "2026-05-25T11:00:00Z" },
    ];
    const out = sortNewestFirst(input);
    expect(out).not.toBe(input);
    expect(input.map((e) => e.id)).toEqual(["a", "b"]); // unchanged
  });
});

describe("entriesForTarget", () => {
  it("returns only entries matching targetType + targetId", () => {
    const a: AuditLogEntry = { ...validEntry, id: "a", targetId: "ev_1" };
    const b: AuditLogEntry = { ...validEntry, id: "b", targetId: "ev_2" };
    const c: AuditLogEntry = { ...validEntry, id: "c", targetId: "ev_1" };
    expect(entriesForTarget([a, b, c], "evidence", "ev_1").map((e) => e.id)).toEqual([
      "a",
      "c",
    ]);
  });

  it("returns empty when target type doesn't match", () => {
    expect(entriesForTarget([validEntry], "snag", "ev_xyz12345")).toEqual([]);
  });
});

describe("monthBucket", () => {
  it("extracts yyyy-mm from a full ISO timestamp", () => {
    expect(monthBucket("2026-05-25T14:30:00.000Z")).toBe("2026-05");
    expect(monthBucket("2026-12-31T23:59:59.999Z")).toBe("2026-12");
  });

  it("returns empty string for bad input", () => {
    expect(monthBucket("")).toBe("");
    expect(monthBucket("2026")).toBe("");
    expect(monthBucket("nonsense" as unknown as string)).toBe("");
  });
});
